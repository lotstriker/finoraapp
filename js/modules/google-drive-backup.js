// ==========================================================================
// Finora — modules/google-drive-backup.js
//
// Google Drive "App Data" backup. Cross-checked against Google's docs:
//   * Drive API v3 — files.list (spaces=appDataFolder), files.get alt=media, upload guide
//     (multipart <= 5 MB, resumable above; UPDATE a resumable upload with PATCH — PUT
//     does not return the session Location), file `version` ("monotonically increasing")
//   * Custom file properties: max 124 BYTES per property (key + value, UTF-8)
//   * Drive usage limits: 403 userRateLimitExceeded / rateLimitExceeded and 429 -> back off
//     and retry; 5xx -> retry; other 403 -> permission problem, do NOT retry
//   * Identity Services token model (see google-auth.js)
//
// DESIGN
//   * One cloud file PER DATASET: finora-dataset-{datasetId}.json. The datasetId lives in the
//     data and travels with backups, so a phone that restores the PC's backup syncs to the SAME
//     file, while a second profile gets its own file.
//   * Optimistic concurrency: this device remembers the file's `version` from its last sync. If
//     the cloud copy moved on since, Backup refuses (CloudConflictError) instead of silently
//     erasing the other device's data.
//   * `contentHash` (SHA-256 of the exported data) lets automatic sync skip uploads when
//     nothing really changed.
//   * Older files stay readable: "finora-google-backup.json" (v2) and "finora-backup-{id}.json".
//
// The encryption key is derived from the Google account id (see README: this protects the file
// from other Google accounts/apps, not from someone holding your Google login).
// ==========================================================================

import {
  exportAllStores, deriveKey, bufToBase64, base64ToBuf,
  PBKDF2_ITERATIONS, LEGACY_PBKDF2_ITERATIONS, BACKUP_VERSION,
  restoreBackup, recordBackupCompleted,
  getDatasetId, setDatasetId, getCloudSync, setCloudSync,
} from './backup.js';
import { ensureAccessToken, invalidateAccessToken, getStableAccountId } from './google-auth.js';
import { getActiveProfile } from './profiles.js';
import { DB_VERSION } from '../core/db.js';
import { ValidationError } from '../core/ledger.js';

const APP_PEPPER = 'finora-gdrive-backup-v1';        // kept for compatibility with existing backups
const V2_FILE_NAME = 'finora-google-backup.json';     // one-per-account (v2)
const DATASET_PREFIX = 'finora-dataset-';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
/** Multipart upload is limited to 5 MB by Google; stay safely below it. */
export const MULTIPART_LIMIT_BYTES = 4 * 1024 * 1024;
/** Drive: a custom property may use at most 124 bytes for key + value (UTF-8). */
export const APP_PROPERTY_MAX_BYTES = 124;

/* ---------------------------------------------------------------------- */
/* Errors                                                                 */
/* ---------------------------------------------------------------------- */

/** Thrown when the cloud copy changed since this device last synced. */
export class CloudConflictError extends Error {
  constructor({ remoteModifiedTime, reason }) {
    super(reason === 'unknown-state'
      ? 'A cloud backup for this data already exists, but this device has not synced with it yet.'
      : 'The cloud backup was changed by another device since you last synced.');
    this.name = 'CloudConflictError';
    this.remoteModifiedTime = remoteModifiedTime;
    this.reason = reason;
  }
}

/** Thrown by restore when several backups exist and the caller must say which one. */
export class CloudChoiceRequired extends Error {
  constructor(backups) { super('Several backups found — choose one.'); this.name = 'CloudChoiceRequired'; this.backups = backups; }
}

/**
 * A Drive/network failure, classified so callers can decide what to do:
 *   kind 'auth'     401 — token dead; sign in again
 *   kind 'scope'    403 (not a rate limit) — permission missing; reconnect and tick the Drive box
 *   kind 'rate'     403 userRateLimitExceeded/rateLimitExceeded or 429 — retry later with backoff
 *   kind 'server'   500/502/503/504 — retry later with backoff
 *   kind 'network'  could not reach Google — retry when online
 *   kind 'notfound' 404
 *   kind 'other'    anything else (e.g. 400) — do not retry blindly
 * `retryable` is true for rate / server / network.
 */
export class DriveError extends Error {
  constructor(message, { kind, status = 0, reason = '' }) {
    super(message);
    this.name = 'DriveError';
    this.kind = kind;
    this.status = status;
    this.reason = reason;
    this.retryable = kind === 'rate' || kind === 'server' || kind === 'network';
  }
}

const RATE_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'sharingRateLimitExceeded', 'quotaExceeded']);

async function toDriveError(res) {
  let reason = '';
  let detail = '';
  try {
    const body = await res.clone().json();
    detail = body?.error?.message || '';
    reason = body?.error?.errors?.[0]?.reason || body?.error?.status || '';
  } catch { /* body was not JSON */ }

  if (res.status === 401) return new DriveError('Your Google session expired — please reconnect.', { kind: 'auth', status: 401, reason });
  if (res.status === 429 || (res.status === 403 && RATE_REASONS.has(reason))) {
    return new DriveError('Google is rate-limiting requests — Finora will retry shortly.', { kind: 'rate', status: res.status, reason });
  }
  if (res.status === 403) {
    return new DriveError(`Google refused access (403). Reconnect and make sure the Drive permission is ticked.${detail ? ` (${detail})` : ''}`, { kind: 'scope', status: 403, reason });
  }
  if (res.status === 404) return new DriveError('The backup file was not found in Google Drive.', { kind: 'notfound', status: 404, reason });
  if (res.status >= 500) return new DriveError('Google Drive is having trouble right now — Finora will retry shortly.', { kind: 'server', status: res.status, reason });
  return new DriveError(`Google Drive request failed (${res.status}).${detail ? ` ${detail}` : ''}`, { kind: 'other', status: res.status, reason });
}

/* ---------------------------------------------------------------------- */
/* Small helpers                                                          */
/* ---------------------------------------------------------------------- */

/** Cuts `str` so its UTF-8 encoding is at most `maxBytes`, never splitting a character. */
export function truncateUtf8(str, maxBytes) {
  const enc = new TextEncoder();
  let out = '';
  let used = 0;
  for (const ch of String(str ?? '')) {                 // iterates by code point
    const n = enc.encode(ch).length;
    if (used + n > maxBytes) break;
    out += ch; used += n;
  }
  return out;
}

/** appProperties that respect Drive's 124-byte (key + value) limit per property. */
export function buildAppProperties({ datasetId, profileName }) {
  const props = { app: 'finora' };
  props.datasetId = truncateUtf8(datasetId, APP_PROPERTY_MAX_BYTES - 'datasetId'.length);
  const name = truncateUtf8(profileName || '', APP_PROPERTY_MAX_BYTES - 'profileName'.length);
  if (name) props.profileName = name;
  return props;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Bookkeeping that changes on its own (every backup, every daily notification) must not count as
// "your data changed", or the hash would never be stable and "unchanged" could never be detected.
const HASH_IGNORED_SETTINGS = new Set(['lastBackupAt', 'notifiedLog']);

/** Hash of the data that would be backed up (stable: stores are read in key order). */
export async function hashStores(stores) {
  const stable = { ...stores, settings: (stores.settings || []).filter((r) => !HASH_IGNORED_SETTINGS.has(r.key)) };
  return sha256Hex(JSON.stringify(stable));
}

/* ---------------------------------------------------------------------- */
/* Drive HTTP helper                                                      */
/* ---------------------------------------------------------------------- */

async function driveFetch(url, options = {}, { retried = false, interactive = true } = {}) {
  const token = await ensureAccessToken({ interactive });
  if (!token) throw new DriveError('Not connected to Google — please reconnect.', { kind: 'auth', status: 401 });

  let res;
  try {
    res = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
  } catch {
    throw new DriveError('Could not reach Google Drive — check your internet connection.', { kind: 'network' });
  }

  if (res.status === 401 && !retried) {          // token died mid-session: refresh once and retry
    invalidateAccessToken();
    return driveFetch(url, options, { retried: true, interactive });
  }
  if (!res.ok) throw await toDriveError(res);
  return res;
}

/* ---------------------------------------------------------------------- */
/* Listing / classifying cloud files                                      */
/* ---------------------------------------------------------------------- */

function classify(file) {
  const props = file.appProperties || {};
  if (file.name.startsWith(DATASET_PREFIX)) {
    return { type: 'dataset', datasetId: props.datasetId || file.name.slice(DATASET_PREFIX.length).replace(/\.json$/, ''), profileName: props.profileName || '' };
  }
  if (file.name === V2_FILE_NAME) return { type: 'legacy', datasetId: null, profileName: '' };
  if (/^finora-backup-.+\.json$/.test(file.name)) return { type: 'legacy', datasetId: null, profileName: '' };
  return null; // not ours
}

/**
 * All Finora backups in this Google account, newest first.
 * `interactive:false` is used by automatic sync: never open a sign-in popup in the background.
 */
export async function listCloudBackups({ interactive = true } = {}) {
  const url = `${DRIVE}?spaces=appDataFolder&pageSize=100&orderBy=${encodeURIComponent('modifiedTime desc')}` +
    `&fields=${encodeURIComponent('files(id,name,modifiedTime,version,size,appProperties)')}`;
  const data = await (await driveFetch(url, {}, { interactive })).json();
  return (data.files || []).map((f) => {
    const c = classify(f);
    return c ? { id: f.id, name: f.name, modifiedTime: f.modifiedTime, version: f.version != null ? String(f.version) : '', size: Number(f.size) || 0, ...c } : null;
  }).filter(Boolean);
}

/** Summary for the Settings card: this dataset's backup (if any) and how many others exist. */
export async function getGoogleDriveBackupInfo() {
  const [all, datasetId] = await Promise.all([listCloudBackups(), getDatasetId()]);
  const mine = all.find((b) => b.type === 'dataset' && b.datasetId === datasetId) || null;
  return { mine, others: all.filter((b) => b !== mine), total: all.length };
}

/** True when the cloud file differs from what this device last synced (version, else modifiedTime). */
export function cloudMovedOn(remote, sync, datasetId) {
  if (!remote) return false;
  if (!sync || sync.datasetId !== datasetId || sync.fileId !== remote.id) return true;
  if (remote.version && sync.version) return remote.version !== sync.version;
  return remote.modifiedTime !== sync.modifiedTime;
}

/* ---------------------------------------------------------------------- */
/* Container (encrypt / decrypt)                                          */
/* ---------------------------------------------------------------------- */

async function createBackupContainer(stableId, datasetId, stores) {
  const plaintext = new TextEncoder().encode(JSON.stringify({ stores, exportedAt: new Date().toISOString() }));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(stableId + APP_PEPPER, salt, 'encrypt');
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    version: BACKUP_VERSION,
    dbAppVersion: DB_VERSION,
    algorithm: 'AES-256-GCM',
    kdf: 'PBKDF2',
    iterations: PBKDF2_ITERATIONS,
    salt: bufToBase64(salt),
    iv: bufToBase64(iv),
    ciphertext: bufToBase64(ciphertext),
    timestamp: new Date().toISOString(),
    keySource: 'google-account',
    datasetId,
  };
}

async function decryptContainer(fileContent, stableId) {
  let container;
  try { container = JSON.parse(fileContent); } catch { throw new ValidationError('The Google Drive backup is corrupted or unreadable.'); }
  if (!container?.ciphertext || !container.salt || !container.iv) {
    throw new ValidationError('The Google Drive backup is corrupted or in an unrecognized format.');
  }
  try {
    const key = await deriveKey(stableId + APP_PEPPER, base64ToBuf(container.salt), 'decrypt',
      Number(container.iterations) || LEGACY_PBKDF2_ITERATIONS);
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuf(container.iv) }, key, base64ToBuf(container.ciphertext));
    return { payload: JSON.parse(new TextDecoder().decode(buf)), container };
  } catch {
    throw new ValidationError('Could not decrypt this backup — it may belong to a different Google account.');
  }
}

/* ---------------------------------------------------------------------- */
/* Upload (multipart <= 4 MB, resumable above)                            */
/* ---------------------------------------------------------------------- */

async function uploadFile({ fileId, name, appProperties, content, interactive }) {
  const bytes = new TextEncoder().encode(content);
  const metadata = fileId ? { appProperties } : { name, parents: ['appDataFolder'], appProperties };
  const fields = 'id,modifiedTime,version';
  const target = fileId ? `${UPLOAD}/${encodeURIComponent(fileId)}` : UPLOAD;
  const method = fileId ? 'PATCH' : 'POST';            // PATCH, not PUT: PUT gives no resumable session Location
  let result;

  if (bytes.length <= MULTIPART_LIMIT_BYTES) {
    const boundary = `finora-${Date.now().toString(36)}`;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
    const res = await driveFetch(`${target}?uploadType=multipart&fields=${fields}`, {
      method, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    }, { interactive });
    result = await res.json();
  } else {
    // Resumable: 1) open a session with the metadata, 2) send the bytes to the session URL.
    const init = await driveFetch(`${target}?uploadType=resumable&fields=${fields}`, {
      method,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/json',
        'X-Upload-Content-Length': String(bytes.length),
      },
      body: JSON.stringify(metadata),
    }, { interactive });
    const session = init.headers.get('Location');
    if (!session) throw new DriveError('Google did not open an upload session — please try again.', { kind: 'other' });
    let put;
    try { put = await fetch(session, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: bytes }); }
    catch { throw new DriveError('Upload was interrupted — check your connection.', { kind: 'network' }); }
    if (!put.ok) throw await toDriveError(put);
    result = await put.json();
  }

  // Be defensive: if the final response did not echo the requested fields, ask for them.
  if (!result.version || !result.modifiedTime) {
    const meta = await (await driveFetch(`${DRIVE}/${encodeURIComponent(result.id)}?fields=${fields}`, {}, { interactive })).json();
    result = { ...result, ...meta };
  }
  return result;
}

/* ---------------------------------------------------------------------- */
/* Backup                                                                 */
/* ---------------------------------------------------------------------- */

/**
 * Backs this profile's data up to Google Drive.
 *   force            overwrite even if the cloud copy changed since our last sync
 *   skipIfUnchanged  automatic sync: do nothing when the data is identical to what is already in the cloud
 *   interactive      false for background sync (never opens a popup)
 * Throws CloudConflictError if the cloud copy changed since this device last synced.
 * Returns { timestamp, skipped? }.
 */
export async function backupToGoogleDrive({ force = false, skipIfUnchanged = false, interactive = true } = {}) {
  const stableId = getStableAccountId();
  if (!stableId) throw new DriveError('Not connected to Google — please reconnect.', { kind: 'auth', status: 401 });

  const datasetId = await getDatasetId();
  const name = `${DATASET_PREFIX}${datasetId}.json`;
  const all = await listCloudBackups({ interactive });
  const remote = all.find((b) => b.name === name) || null;
  const sync = await getCloudSync();

  if (remote && !force && cloudMovedOn(remote, sync, datasetId)) {
    throw new CloudConflictError({ remoteModifiedTime: remote.modifiedTime, reason: sync ? 'remote-changed' : 'unknown-state' });
  }

  const stores = await exportAllStores();
  const contentHash = await hashStores(stores);
  if (skipIfUnchanged && remote && sync?.contentHash === contentHash && !cloudMovedOn(remote, sync, datasetId)) {
    return { timestamp: sync.at, skipped: true };
  }

  const container = await createBackupContainer(stableId, datasetId, stores);
  const result = await uploadFile({
    fileId: remote?.id, name,
    appProperties: buildAppProperties({ datasetId, profileName: getActiveProfile()?.name }),
    content: JSON.stringify(container),
    interactive,
  });

  await setCloudSync({
    datasetId, fileId: result.id, version: result.version != null ? String(result.version) : '',
    modifiedTime: result.modifiedTime, contentHash, at: new Date().toISOString(),
  });
  await recordBackupCompleted();
  return { timestamp: container.timestamp };
}

/* ---------------------------------------------------------------------- */
/* Restore                                                                */
/* ---------------------------------------------------------------------- */

/**
 * Downloads a cloud backup and applies it (mode 'merge' | 'replace').
 * With several backups present you must pass {fileId}; otherwise CloudChoiceRequired
 * carries the list so the UI can ask. Restoring a dataset file adopts its datasetId, so
 * this device keeps syncing to that same file afterwards.
 */
export async function restoreFromGoogleDrive(mode = 'merge', { fileId, interactive = true, beforeApply } = {}) {
  const stableId = getStableAccountId();
  if (!stableId) throw new DriveError('Not connected to Google — please reconnect.', { kind: 'auth', status: 401 });

  const all = await listCloudBackups({ interactive });
  if (all.length === 0) throw new ValidationError('No Google Drive backup found for this Google account.');

  let chosen;
  if (fileId) {
    chosen = all.find((b) => b.id === fileId);
  } else if (all.length === 1) {
    chosen = all[0];
  } else {
    // Several backups and no explicit choice: use this profile's own file if it has one,
    // otherwise make the caller ask the user.
    const myId = await getDatasetId();
    chosen = all.find((b) => b.type === 'dataset' && b.datasetId === myId);
    if (!chosen) throw new CloudChoiceRequired(all);
  }
  if (!chosen) throw new ValidationError('That backup is no longer in Google Drive.');

  const text = await (await driveFetch(`${DRIVE}/${encodeURIComponent(chosen.id)}?alt=media`, {}, { interactive })).text();
  const { payload, container } = await decryptContainer(text, stableId);
  if (!payload || typeof payload !== 'object' || !payload.stores) {
    throw new ValidationError('This backup is invalid or incompatible with this version of Finora.');
  }

  // Automatic sync passes beforeApply to re-check for edits made while we were downloading;
  // it throws to abort so a replace can never erase something typed a moment ago.
  if (beforeApply) await beforeApply(chosen);
  // A cloud-driven REPLACE gives this device an exact copy of data already in the cloud, so it is not a
  // "change" to upload again. A MERGE does change local data, so it stays visible as a change.
  await restoreBackup(payload, mode, { quiet: mode === 'replace' });

  if (chosen.type === 'dataset') {
    const id = chosen.datasetId || container.datasetId;
    if (id) {
      await setDatasetId(id);
      // Remember what we are now in sync with, including a hash of OUR data, so the next
      // automatic backup is skipped when nothing has changed since this restore.
      await setCloudSync({
        datasetId: id, fileId: chosen.id, version: chosen.version, modifiedTime: chosen.modifiedTime,
        contentHash: await hashStores(await exportAllStores()), at: new Date().toISOString(),
      });
    }
  }
  return { timestamp: chosen.modifiedTime, dbAppVersion: payload.dbAppVersion ?? null, storageType: chosen.type, profileName: chosen.profileName };
}
