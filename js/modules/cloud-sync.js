// ==========================================================================
// Finora — modules/cloud-sync.js
//
// AUTOMATIC cloud sync on top of the Google Drive backup:
//   A. Auto-backup  — a few seconds after you change data, it is saved to Drive.
//   B. Check cloud  — when Finora opens, comes back to the foreground, or comes back
//                     online, it looks at Drive; if ANOTHER device saved newer data and you
//                     have no unsaved changes here, it updates this device.
//
// This is NOT real-time sync (that needs a server). It is "copy + merge with safety checks".
//
// WHAT THE OFFICIAL DOCS REQUIRE (and how this file follows them)
//   * Google Identity token model: a new access token needs a USER GESTURE once the old one
//     expires (~1 hour). So background sync only uses `prompt:'none'` (silent, no popup).
//     If Google can't answer silently the state becomes 'needs-reconnect' and the UI shows a
//     one-tap "Reconnect" — we never fire popups in the background.
//   * Drive usage limits: 403 userRateLimitExceeded / rateLimitExceeded and 429 (and 5xx) ->
//     truncated exponential backoff with jitter (computeBackoffMs). Other 403 -> not retried.
//   * Page Visibility API (MDN): `hidden` is the last reliably observable event, so a pending
//     backup is flushed then (best effort — the page may be frozen, so the "dirty" marker is
//     persisted and the next open finishes the job). `pagehide` is also listened to because
//     older iOS Safari doesn't fire visibilitychange when navigating away.
//   * Web Locks API (MDN): navigator.locks.request(name, {ifAvailable:true}, cb) — if another
//     tab is already syncing the callback gets null and we skip (secure contexts only; without
//     it we fall back to an in-tab guard).
//
// SAFETY RULES (data is never silently overwritten)
//   * Cloud changed AND you have unsaved local changes  -> 'conflict' (you decide).
//   * Cloud changed and you have NO unsaved changes     -> safe fast-forward (exact copy).
//   * No cloud file for this profile but other backups exist -> 'choose-backup' (restore one,
//     or explicitly start a separate backup) — auto-backup never silently forks your data.
// ==========================================================================

import { onDataChanged, getAll } from '../core/db.js';
import { getSetting, setSetting } from './preferences.js';
import { AUTO_SYNC_KEY, CLOUD_DIRTY_KEY, CLOUD_START_FRESH_KEY, getDatasetId, getCloudSync } from './backup.js';
import { isConnected, isGoogleConfigured } from './google-auth.js';
import { listCloudBackups, backupToGoogleDrive, restoreFromGoogleDrive, cloudMovedOn, CloudConflictError } from './google-drive-backup.js';
import { getActiveProfile } from './profiles.js';

/** Quiet period after the LAST change before auto-backup runs. */
export const DEBOUNCE_MS = 30 * 1000;
/** Even with continuous edits, back up at least this often. */
export const MAX_WAIT_MS = 3 * 60 * 1000;
/** Foreground re-check interval while the app is visible. */
export const POLL_MS = 5 * 60 * 1000;
/** Re-check on becoming visible only if the last check is older than this. */
export const VISIBLE_RECHECK_MS = 2 * 60 * 1000;
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;
const DEFER_APPLY_MS = 15 * 1000;

/**
 * Truncated exponential backoff (Drive docs): base * 2^(attempt-1), capped, plus random jitter so
 * many clients don't retry in lock-step.
 */
export function computeBackoffMs(attempt, random = Math.random) {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.min(BACKOFF_MAX_MS, exp + Math.floor(random() * 1000));
}

/* ---------------------------------------------------------------------- */
/* Status (what the UI shows)                                             */
/* ---------------------------------------------------------------------- */
/**
 * state:
 *   off              automatic sync is not running (not connected / switched off)
 *   idle             everything is saved                       (lastSyncedAt)
 *   pending          changes are waiting for the quiet period
 *   syncing          talking to Google right now
 *   offline          no internet; will continue when back online
 *   needs-reconnect  Google needs one tap (token expired / permission missing)
 *   conflict         cloud has newer data AND this device has unsaved changes -> user decides
 *   update-available cloud has newer data; not applied yet (a dialog is open)
 *   choose-backup    other backups exist but none for this profile -> user decides
 *   error            something failed (message); retries automatically if retryable
 */
let status = { state: 'off', lastSyncedAt: null, message: '', remote: null, backups: null, retryAt: null };
const subscribers = new Set();

function setStatus(patch) {
  status = { ...status, retryAt: null, ...patch };
  for (const fn of subscribers) { try { fn(status); } catch { /* UI errors must not break sync */ } }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('finora:sync-status', { detail: status }));
  }
}

export const getSyncStatus = () => status;
export function onSyncStatus(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

/* ---------------------------------------------------------------------- */
/* Internal state                                                         */
/* ---------------------------------------------------------------------- */
let hooks = { isBusy: () => false, onRemoteApplied: () => {} };
let active = false;          // connected + configured + switch on
let started = false;
let changeSeq = 0;           // counts data changes in this tab
let dirtyCached = false;     // mirror of the persisted "cloudDirty" marker
let debounceTimer = null;
let firstPendingAt = null;
let retryTimer = null;
let retryAttempt = 0;
let pollTimer = null;
let lastCheckAt = 0;
let inFlight = null;
let teardown = [];

const hasWindow = typeof window !== 'undefined' && typeof document !== 'undefined';
const online = () => (typeof navigator === 'undefined' || navigator.onLine !== false);

/* ---------------------------------------------------------------------- */
/* Settings                                                               */
/* ---------------------------------------------------------------------- */

/** Automatic sync switch — per DEVICE (not in backups). Defaults to ON once Google is connected. */
export async function isAutoSyncEnabled() {
  return (await getSetting(AUTO_SYNC_KEY, true)) !== false;
}

export async function setAutoSyncEnabled(on) {
  await setSetting(AUTO_SYNC_KEY, !!on);
  await refreshCloudSync();
}

async function readDirty() {
  return !!(await getSetting(CLOUD_DIRTY_KEY, null));
}

async function setDirty(on) {
  dirtyCached = on;
  await setSetting(CLOUD_DIRTY_KEY, on ? { since: new Date().toISOString() } : null);
}

/** "Has this device any data worth protecting?" (a brand-new profile has none). */
async function hasUserData() {
  const [accounts, ledger] = await Promise.all([getAll('accounts'), getAll('ledger')]);
  return accounts.length > 0 || ledger.length > 0;
}

/* ---------------------------------------------------------------------- */
/* Scheduling                                                             */
/* ---------------------------------------------------------------------- */

function clearTimers() {
  clearTimeout(debounceTimer); debounceTimer = null; firstPendingAt = null;
  clearTimeout(retryTimer); retryTimer = null;
}

// States that need the USER (a tap / a decision). Retrying silently every 30 s would only spam
// Google; the changes stay marked dirty and are saved right after the user resolves it.
const NEEDS_USER = new Set(['needs-reconnect', 'conflict', 'choose-backup']);

function scheduleBackup() {
  if (!active || NEEDS_USER.has(status.state)) return;
  firstPendingAt ??= Date.now();
  clearTimeout(debounceTimer);
  const wait = Math.min(DEBOUNCE_MS, Math.max(0, firstPendingAt + MAX_WAIT_MS - Date.now()));
  debounceTimer = setTimeout(() => { firstPendingAt = null; runSyncCycle({ reason: 'changes' }); }, wait);
  if (status.state === 'idle' || status.state === 'pending') setStatus({ state: 'pending' });
}

function scheduleRetry(ms, reason) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => runSyncCycle({ reason }), ms);
  status = { ...status, retryAt: Date.now() + ms };
}

/** Re-evaluates whether sync should run (call after connect / disconnect / toggle). */
export async function refreshCloudSync() {
  active = started && isGoogleConfigured() && isConnected() && (await isAutoSyncEnabled());
  if (!active) {
    clearTimers();
    setStatus({ state: 'off', message: '' });
    return false;
  }
  if (status.state === 'off') {
    const sync = await getCloudSync();
    setStatus({ state: dirtyCached ? 'pending' : 'idle', lastSyncedAt: sync?.at || null, message: '' });
  }
  return true;
}

/* ---------------------------------------------------------------------- */
/* The sync cycle                                                         */
/* ---------------------------------------------------------------------- */

async function withLock(fn) {
  if (inFlight) return inFlight;                            // same tab: coalesce
  const name = `finora-cloud-sync:${getActiveProfile()?.id || 'default'}`;
  const run = async () => {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (locks?.request) {
      // Another tab already syncing -> callback receives null -> skip (don't wait, don't double-upload).
      return locks.request(name, { ifAvailable: true }, async (lock) => (lock ? fn() : { skipped: 'other-tab' }));
    }
    return fn();
  };
  inFlight = run().finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * One full "check the cloud, then save/update" pass. Safe to call any time (it coalesces and
 * respects the rules in the header). `interactive:true` ONLY from a user click (may open Google's popup).
 * Returns the resulting status.
 */
export async function runSyncCycle({ interactive = false, reason = 'manual' } = {}) {
  if (!started) return status;
  if (!(await refreshCloudSync())) return status;
  if (!online()) { setStatus({ state: 'offline', message: 'You are offline — Finora will sync when you are back online.' }); return status; }

  const result = await withLock(async () => {
    const seqAtStart = changeSeq;
    clearTimeout(debounceTimer); firstPendingAt = null;
    setStatus({ state: 'syncing', message: '' });
    lastCheckAt = Date.now();
    try {
      await syncOnce({ interactive, seqAtStart });
      retryAttempt = 0;
    } catch (err) {
      handleError(err);
    }
  });
  if (result?.skipped === 'other-tab') return status;
  return status;
}

async function syncOnce({ interactive, seqAtStart }) {
  const datasetId = await getDatasetId();
  const all = await listCloudBackups({ interactive });
  const remote = all.find((b) => b.type === 'dataset' && b.datasetId === datasetId) || null;
  const sync = await getCloudSync();
  const dirty = dirtyCached || (await readDirty());

  // ---- no cloud file for THIS profile yet ----
  if (!remote) {
    if (all.length > 0 && !(await getSetting(CLOUD_START_FRESH_KEY, false))) {
      // Other backups exist (another device / profile). Never fork silently — ask once.
      if (await hasUserData() && sync) { /* we synced before but our file vanished: just recreate it below */ } else {
        setStatus({ state: 'choose-backup', backups: all, message: 'Backups from another device or profile were found.' });
        return;
      }
    }
    if (await hasUserData()) { await saveToCloud({ interactive, seqAtStart }); return; }
    setStatus({ state: 'idle', message: '', lastSyncedAt: sync?.at || null });
    return;
  }

  // ---- cloud file exists ----
  if (!cloudMovedOn(remote, sync, datasetId)) {
    if (dirty) await saveToCloud({ interactive, seqAtStart });
    else setStatus({ state: 'idle', message: '', lastSyncedAt: sync?.at || null });
    return;
  }

  // The cloud copy moved on (another device saved).
  if (!dirty && (sync || !(await hasUserData()))) {
    await fastForward(remote, { interactive, seqAtStart });     // nothing local to lose -> exact copy
    return;
  }
  setStatus({ state: 'conflict', remote: { modifiedTime: remote.modifiedTime, id: remote.id }, message: 'Cloud has newer data and this device also has unsaved changes.' });
}

async function saveToCloud({ interactive, seqAtStart }) {
  const res = await backupToGoogleDrive({ skipIfUnchanged: true, interactive });
  if (changeSeq === seqAtStart) await setDirty(false);           // only if nothing changed while uploading
  const sync = await getCloudSync();
  setStatus({ state: changeSeq === seqAtStart ? 'idle' : 'pending', message: '', lastSyncedAt: sync?.at || res.timestamp || new Date().toISOString() });
  if (changeSeq !== seqAtStart) scheduleBackup();
}

async function fastForward(remote, { interactive, seqAtStart }) {
  if (hooks.isBusy()) {
    // A dialog is open: don't swap the data under the user's hands. Try again shortly.
    setStatus({ state: 'update-available', remote: { modifiedTime: remote.modifiedTime, id: remote.id }, message: 'Newer data from another device is ready.' });
    scheduleRetry(DEFER_APPLY_MS, 'deferred-apply');
    return;
  }
  await restoreFromGoogleDrive('replace', {
    fileId: remote.id, interactive,
    // Edited while the download was running (this tab or another)? Then it is a conflict, not a safe copy.
    beforeApply: async () => {
      if (changeSeq !== seqAtStart || (await readDirty())) throw new CloudConflictError({ remoteModifiedTime: remote.modifiedTime, reason: 'remote-changed' });
    },
  });
  await setDirty(false);
  const sync = await getCloudSync();
  setStatus({ state: 'idle', message: '', remote: null, lastSyncedAt: sync?.at || new Date().toISOString() });
  try { hooks.onRemoteApplied({ modifiedTime: remote.modifiedTime }); } catch { /* UI refresh must not break sync */ }
}

function handleError(err) {
  const name = err?.name;
  if (name === 'CloudConflictError') {
    setStatus({ state: 'conflict', remote: { modifiedTime: err.remoteModifiedTime }, message: err.message });
    return;
  }
  if (name === 'DriveError') {
    if (err.kind === 'auth' || err.kind === 'scope') {
      setStatus({ state: 'needs-reconnect', message: err.kind === 'scope' ? err.message : 'Google needs you to sign in again (access expires after about an hour).' });
      return;
    }
    if (err.retryable) {
      retryAttempt += 1;
      const delay = computeBackoffMs(retryAttempt);
      setStatus({ state: err.kind === 'network' && !online() ? 'offline' : 'error', message: err.message });
      scheduleRetry(delay, 'retry');
      return;
    }
  }
  setStatus({ state: 'error', message: err?.message || 'Sync failed.' });   // e.g. bad file: not retried blindly
}

/* ---------------------------------------------------------------------- */
/* Triggers                                                               */
/* ---------------------------------------------------------------------- */

/** Public: run a cycle right now (Settings "Sync now", after connecting, etc.). */
export function requestSync(reason = 'manual', { interactive = false } = {}) {
  return runSyncCycle({ reason, interactive });
}

/** Called when the page becomes hidden/visible. Exported so tests (and the app) can drive it. */
export function handleVisibility(visibilityState) {
  if (!started) return;
  if (visibilityState === 'hidden') {
    clearInterval(pollTimer); pollTimer = null;
    // Last reliably observable moment (MDN): flush pending changes now, best effort.
    if (active && (dirtyCached || debounceTimer)) runSyncCycle({ reason: 'hidden' });
    return;
  }
  startPolling();
  if (active && Date.now() - lastCheckAt > VISIBLE_RECHECK_MS) runSyncCycle({ reason: 'visible' });
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (active) runSyncCycle({ reason: 'poll' }); }, POLL_MS);
  pollTimer.unref?.();
}

/**
 * Starts automatic sync. Call once after the database is open. Returns a stop() function.
 * hooks.isBusy()          -> true while a dialog is open (don't replace data under the user)
 * hooks.onRemoteApplied() -> refresh the screen after data arrived from another device
 */
export async function initCloudSync({ isBusy, onRemoteApplied } = {}) {
  if (started) return stopCloudSync;
  started = true;
  hooks = { isBusy: isBusy || (() => false), onRemoteApplied: onRemoteApplied || (() => {}) };
  dirtyCached = await readDirty();

  // Track changes ALWAYS (even if sync is off): the marker decides later whether it is safe to
  // overwrite this device with cloud data.
  const unsub = onDataChanged(() => {
    changeSeq += 1;
    if (!dirtyCached) setDirty(true).catch(() => {});
    scheduleBackup();
  });
  teardown = [unsub];

  if (hasWindow) {
    const onVis = () => handleVisibility(document.visibilityState);
    const onHide = () => handleVisibility('hidden');
    const onOnline = () => { if (active) runSyncCycle({ reason: 'online' }); };
    const onOffline = () => { if (active) setStatus({ state: 'offline', message: 'You are offline — Finora will sync when you are back online.' }); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onHide);           // older iOS Safari skips visibilitychange on navigation
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    teardown.push(() => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    });
  }

  await refreshCloudSync();
  if (active) {
    startPolling();
    const t = setTimeout(() => runSyncCycle({ reason: 'startup' }), 1500);   // let the first screen paint first
    t.unref?.();
    teardown.push(() => clearTimeout(t));
  }
  return stopCloudSync;
}

export function stopCloudSync() {
  teardown.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  teardown = [];
  clearTimers();
  clearInterval(pollTimer); pollTimer = null;
  started = false; active = false;
  setStatus({ state: 'off', message: '' });
}

/** Test helper: wipe all in-memory state. */
export function __resetCloudSyncForTests() {
  stopCloudSync();
  status = { state: 'off', lastSyncedAt: null, message: '', remote: null, backups: null, retryAt: null };
  changeSeq = 0; dirtyCached = false; retryAttempt = 0; lastCheckAt = 0; inFlight = null;
}

/** The user chose "start a separate backup for this profile" (instead of restoring another one). */
export async function chooseStartFreshBackup() {
  await setSetting(CLOUD_START_FRESH_KEY, true);
  return runSyncCycle({ reason: 'start-fresh', interactive: true });
}

/** Marks the profile as clean after the user resolved things by hand (restore / merge / overwrite). */
export async function markSynced() {
  await setDirty(false);
}
