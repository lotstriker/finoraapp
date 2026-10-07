// ==========================================================================
// Finora — modules/server-sync.js
// WHEN to sync (the engine in sync-engine.js decides WHAT to sync).
//
//   * a few seconds after you change data                       -> push (and pull)
//   * Supabase Realtime says "something changed" (a HINT only)  -> pull within ~0.5 s   => "live"
//   * app opens / returns to the foreground / comes back online -> sync
//   * safety net poll: every 60 s if Realtime isn't connected, every 5 min otherwise
//
// Rules (from the Supabase / MDN docs):
//   * Realtime is best-effort: events can be missed (reconnects), so correctness always comes from
//     "pull everything after my cursor" — an event just makes us pull sooner.
//   * Realtime Postgres Changes do not filter DELETE events by RLS, which is why the server never
//     hard-deletes (tombstones only; see supabase/schema.sql).
//   * Free-plan projects pause after a week of inactivity -> network errors degrade to "offline"
//     with backoff; the local app keeps working.
//   * Web Locks: only one tab syncs at a time.
// ==========================================================================

import { onDataChanged } from '../core/db.js';
import { getSetting, setSetting } from './preferences.js';
import { getDatasetId, getDeviceId, setDatasetId } from './backup.js';
import { isSupabaseConfigured, getClient, getSession } from './supabase-client.js';
import { loadLocalKey } from './e2e-crypto.js';
import { syncOnce, resetSyncState, isApplyingRemote } from './sync-engine.js';

export const SERVER_SYNC_KEY = 'serverSyncEnabled';
/** Timings in ms. One object so tests can shrink them. */
export const TIMING = {
  debounce: 2000,            // after your last edit
  maxWait: 10000,            // even while you keep editing
  realtime: 400,             // after a Realtime hint
  pollNoRealtime: 60 * 1000, // safety net while Realtime is down
  pollWithRealtime: 5 * 60 * 1000,
  busyRetry: 3000,           // a dialog is open: try again shortly
  startup: 800,
};
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const MAX_AUTO_RETRIES = 6;

export const serverBackoffMs = (attempt, random = Math.random) =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1) + Math.floor(random() * 1000));

/* ---------- status ---------- */
/**
 * off | idle | pending | syncing | offline | needs-signin | needs-unlock | error
 * plus: lastSyncedAt, message, conflicts (unseen overwritten edits), realtime (bool)
 */
let status = { state: 'off', lastSyncedAt: null, message: '', conflicts: 0, realtime: false, retryAt: null };
const subscribers = new Set();
function setStatus(patch) {
  status = { ...status, retryAt: null, ...patch };
  for (const fn of subscribers) { try { fn(status); } catch { /* UI errors must not break sync */ } }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('finora:server-sync-status', { detail: status }));
  }
}
export const getServerSyncStatus = () => status;
export function onServerSyncStatus(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

/* ---------- internal state ---------- */
let hooks = { isBusy: () => false, onRemoteApplied: () => {} };
let started = false;
let enabled = false;
let debounceTimer = null; let firstPendingAt = null;
let retryTimer = null; let retryAttempt = 0;
let pollTimer = null;
let realtime = null;            // { client, channel, datasetId }
let inFlight = null;
let teardown = [];
const hasWindow = typeof window !== 'undefined' && typeof document !== 'undefined';
const online = () => (typeof navigator === 'undefined' || navigator.onLine !== false);

/* ---------- enable / disable / join ---------- */
export async function isServerSyncEnabled() { return (await getSetting(SERVER_SYNC_KEY, false)) === true; }

/** Datasets stored on the server for this account (to JOIN one from a new device). */
export async function listServerDatasets() {
  const client = await getClient();
  const { data, error } = await client.rpc('sync_list_datasets');
  if (error) throw new Error(`Could not list your synced data: ${error.message}`);
  return data || [];
}

/**
 * Turn live sync on for THIS device.
 *  joinDatasetId  -> adopt that dataset (the new device joins data another device uploaded)
 *  (omitted)      -> use this device's own dataset id (the first device, or a separate profile)
 * Either way the first sync MERGES: the server's records are applied, then this device's extra records are pushed.
 */
export async function enableServerSync({ joinDatasetId } = {}) {
  if (joinDatasetId) await setDatasetId(joinDatasetId);
  await resetSyncState();                                    // first sync = a clean merge, with no stale bookkeeping
  await setSetting(SERVER_SYNC_KEY, true);
  await refreshServerSync();
  return runServerSync({ reason: 'enabled' });
}

export async function disableServerSync() {
  await setSetting(SERVER_SYNC_KEY, false);
  await refreshServerSync();                                 // server data is untouched; other devices keep syncing
}

export async function refreshServerSync() {
  enabled = started && isSupabaseConfigured() && (await isServerSyncEnabled());
  if (!enabled) {
    clearTimeout(debounceTimer); clearTimeout(retryTimer); debounceTimer = retryTimer = null; firstPendingAt = null;
    await stopRealtime();
    setStatus({ state: 'off', message: '', realtime: false });
  } else if (status.state === 'off') setStatus({ state: 'idle', message: '' });
  return enabled;
}

/* ---------- scheduling ---------- */
function schedule(reason, ms) {
  if (!enabled) return;
  firstPendingAt ??= Date.now();
  clearTimeout(debounceTimer);
  const wait = reason === 'changes' ? Math.min(ms, Math.max(0, firstPendingAt + TIMING.maxWait - Date.now())) : ms;
  debounceTimer = setTimeout(() => { firstPendingAt = null; runServerSync({ reason }); }, wait);
  if (reason === 'changes' && (status.state === 'idle' || status.state === 'pending')) setStatus({ state: 'pending' });
}

function scheduleRetry(ms, reason) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => runServerSync({ reason }), ms);
  status = { ...status, retryAt: Date.now() + ms };
}

async function withLock(datasetId, fn) {
  if (inFlight) return inFlight;
  const run = async () => {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (locks?.request) return locks.request(`finora-server-sync:${datasetId}`, { ifAvailable: true }, async (lock) => (lock ? fn() : { skipped: 'other-tab' }));
    return fn();
  };
  inFlight = run().finally(() => { inFlight = null; });
  return inFlight;
}

/* ---------- the cycle ---------- */
export async function runServerSync({ reason = 'manual' } = {}) {
  if (!started) return status;
  if (!(await refreshServerSync())) return status;
  if (!online()) { setStatus({ state: 'offline', message: 'You are offline — Finora will sync when you are back online.' }); return status; }
  if (hooks.isBusy()) { schedule('busy', TIMING.busyRetry); return status; }      // never swap data under an open dialog

  let ctx;
  try {
    const session = await getSession();
    if (!session) { setStatus({ state: 'needs-signin', message: 'Sign in again to keep syncing.' }); return status; }
    const key = await loadLocalKey(session.user.id);
    if (!key) { setStatus({ state: 'needs-unlock', message: 'Enter your encryption passphrase on this device.' }); return status; }
    const datasetId = await getDatasetId();
    ctx = { client: await getClient(), key, datasetId, deviceId: await getDeviceId(), userId: session.user.id };
  } catch (err) { handleError(err); return status; }

  await withLock(ctx.datasetId, async () => {
    clearTimeout(debounceTimer); firstPendingAt = null;
    setStatus({ state: 'syncing', message: '' });
    try {
      const res = await syncOnce(ctx);
      retryAttempt = 0;
      setStatus({
        state: 'idle', message: '', lastSyncedAt: new Date().toISOString(),
        conflicts: status.conflicts + (res.conflicts || 0), lastResult: res,
      });
      if (res.pulled > 0) notifyApplied();
      await ensureRealtime(ctx);
      if (res.unresolved > 0) schedule('conflict-retry', 1500);                // a conflict persisted through one retry: try again soon
    } catch (err) { handleError(err); }
  });
  return status;
}

function notifyApplied() {
  try { hooks.onRemoteApplied?.(); } catch { /* a UI refresh must never break sync */ }
}

function handleError(err) {
  const msg = String(err?.message || err);
  if (err?.name === 'E2EError') { setStatus({ state: 'error', message: 'Could not decrypt your data — the passphrase may be wrong or the data was tampered with. Sync is paused.' }); return; }
  if (err?.status === 401 || /jwt|not signed in|invalid token|expired/i.test(msg)) { setStatus({ state: 'needs-signin', message: 'Your sign-in expired — please sign in again.' }); return; }
  const network = err instanceof TypeError || /failed to fetch|network|load failed|connection/i.test(msg);
  retryAttempt += 1;
  if (retryAttempt > MAX_AUTO_RETRIES && !network) { setStatus({ state: 'error', message: msg }); return; }
  const delay = serverBackoffMs(retryAttempt);
  setStatus({ state: network ? 'offline' : 'error', message: network ? 'Cannot reach the server (offline, or the free Supabase project is paused). Finora keeps working and will retry.' : msg });
  scheduleRetry(delay, 'retry');
}

/* ---------- realtime: a hint to pull sooner ---------- */
async function ensureRealtime(ctx) {
  if (realtime && realtime.datasetId === ctx.datasetId) return;
  await stopRealtime();
  try {
    const channel = ctx.client.channel(`finora-sync-${ctx.datasetId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sync_records', filter: `dataset_id=eq.${ctx.datasetId}` }, (payload) => {
        if (payload?.new?.device_id && payload.new.device_id === ctx.deviceId) return;     // our own write echoing back
        schedule('realtime', TIMING.realtime);
      })
      .subscribe((s) => {
        const ok = s === 'SUBSCRIBED';
        if (status.realtime !== ok) setStatus({ ...status, realtime: ok, retryAt: status.retryAt });
        startPolling();                                                                    // interval depends on whether Realtime is up
        if (ok) schedule('realtime-connected', TIMING.realtime);                           // catch up on anything missed while disconnected
      });
    realtime = { client: ctx.client, channel, datasetId: ctx.datasetId };
  } catch { /* realtime is a bonus; polling still works */ }
  startPolling();
}

async function stopRealtime() {
  const r = realtime; realtime = null;
  if (r) { try { await r.client.removeChannel(r.channel); } catch { /* ignore */ } }
}

function startPolling() {
  clearInterval(pollTimer);
  const ms = status.realtime ? TIMING.pollWithRealtime : TIMING.pollNoRealtime;
  pollTimer = setInterval(() => { if (enabled) runServerSync({ reason: 'poll' }); }, ms);
  pollTimer.unref?.();
}

/** Page became hidden/visible. Exported for tests. */
export function handleVisibility(state) {
  if (!started || !enabled) return;
  if (state === 'hidden') { clearInterval(pollTimer); pollTimer = null; if (debounceTimer) runServerSync({ reason: 'hidden' }); return; }
  startPolling();
  runServerSync({ reason: 'visible' });
}

/* ---------- lifecycle ---------- */
export async function startServerSync({ isBusy, onRemoteApplied } = {}) {
  if (started) return stopServerSync;
  started = true;
  hooks = { isBusy: isBusy || (() => false), onRemoteApplied: onRemoteApplied || (() => {}) };

  // Writes made by the sync engine itself (remote data landing) are not "the user changed something".
  teardown = [onDataChanged(() => { if (!isApplyingRemote()) schedule('changes', TIMING.debounce); })];
  if (hasWindow) {
    const onVis = () => handleVisibility(document.visibilityState);
    const onHide = () => handleVisibility('hidden');
    const onOnline = () => { if (enabled) runServerSync({ reason: 'online' }); };
    const onOffline = () => { if (enabled) setStatus({ state: 'offline', message: 'You are offline — Finora will sync when you are back online.' }); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    teardown.push(() => {
      document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', onHide);
      window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline);
    });
  }
  if (await refreshServerSync()) { const t = setTimeout(() => runServerSync({ reason: 'startup' }), TIMING.startup); t.unref?.(); teardown.push(() => clearTimeout(t)); }
  return stopServerSync;
}

export async function stopServerSync() {
  teardown.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); teardown = [];
  clearTimeout(debounceTimer); clearTimeout(retryTimer); clearInterval(pollTimer);
  debounceTimer = retryTimer = pollTimer = null; firstPendingAt = null;
  await stopRealtime();
  started = false; enabled = false;
  setStatus({ state: 'off', message: '', realtime: false });
}

export function __resetServerSyncForTests() {
  status = { state: 'off', lastSyncedAt: null, message: '', conflicts: 0, realtime: false, retryAt: null };
  retryAttempt = 0; inFlight = null; realtime = null;
}

export const resetConflictCounter = () => setStatus({ ...status, conflicts: 0 });
