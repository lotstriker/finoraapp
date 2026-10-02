// ==========================================================================
// Finora — modules/google-drive-backup.js
// Backs up the ACTIVE profile's data to Google Drive's hidden App Data
// folder. Reuses the exact same AES-256-GCM/PBKDF2 encryption already
// tested in backup.js's password-based local backup — the only
// difference is the encryption key is derived automatically from the
// connected Google account's stable ID instead of a typed password, so
// restoring on a new device just means signing into the same Google
// account (no password to remember or lose).
//
// One file per profile in the App Data folder (named by profile id) —
// backing up always updates that file in place, never creates a second
// copy for the same profile.
// ==========================================================================

import { exportAllStores, deriveKey, bufToBase64, base64ToBuf, PBKDF2_ITERATIONS, BACKUP_VERSION, restoreBackup, recordBackupCompleted } from './backup.js';
import { getAccessToken, getStableAccountId } from './google-auth.js';
import { getActiveProfile } from './profiles.js';
import { DB_VERSION } from '../core/db.js';
import { ValidationError } from '../core/ledger.js';

// Fixed, non-secret domain-separation string mixed into the derived key —
// this is not itself a security boundary (Drive's App Data access control
// is), it just keeps Finora's derived keys distinct from anything else
// that might ever derive a key from the same Google account id.
const APP_PEPPER = 'finora-gdrive-backup-v1';

function backupFileName() {
  return `finora-backup-${getActiveProfile().id}.json`;
}

async function driveFetch(url, options = {}) {
  const token = getAccessToken();
  if (!token) throw new Error('Not connected to Google — please reconnect.');
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new Error('Your Google session expired — please reconnect.');
  if (!res.ok) throw new Error(`Google Drive request failed (${res.status}).`);
  return res;
}

/** Finds this profile's existing backup file in the App Data folder, if any. */
async function findExistingFile() {
  const name = backupFileName();
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name%3D%27${encodeURIComponent(name)}%27&fields=files(id,name,modifiedTime)`;
  const res = await driveFetch(url);
  const data = await res.json();
  return data.files && data.files.length > 0 ? data.files[0] : null;
}

/**
 * Backs up the active profile to Drive — updates the existing file in
 * place if one exists for this profile, otherwise creates it once.
 * Never leaves more than one backup file per profile.
 */
export async function backupToGoogleDrive() {
  const stableId = getStableAccountId();
  if (!stableId) throw new Error('Not connected to Google — please reconnect.');

  const stores = await exportAllStores();
  const plaintext = new TextEncoder().encode(JSON.stringify({ stores, exportedAt: new Date().toISOString() }));

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(stableId + APP_PEPPER, salt, 'encrypt');
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  const container = {
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
  };
  const fileContent = JSON.stringify(container);

  const existing = await findExistingFile();
  if (existing) {
    await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: fileContent,
    });
  } else {
    const metadata = { name: backupFileName(), parents: ['appDataFolder'] };
    const boundary = 'finora-boundary-' + Date.now();
    const multipartBody =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${fileContent}\r\n--${boundary}--`;
    await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipartBody,
    });
  }

  await recordBackupCompleted();
  return { timestamp: container.timestamp };
}

/**
 * Checks Drive for an existing backup without downloading/decrypting
 * it — used to show "Last Backup: ..." before the user commits to
 * Restore, and to warn if the Drive copy is newer than expected.
 */
export async function getGoogleDriveBackupInfo() {
  const existing = await findExistingFile();
  if (!existing) return null;
  return { modifiedTime: existing.modifiedTime, fileId: existing.id };
}

/**
 * Downloads and decrypts the active profile's Drive backup, then
 * applies it via the existing, already-tested restoreBackup(). Fails
 * cleanly with a ValidationError on a corrupt/incompatible/wrong-account
 * file — never partially applies a bad backup.
 */
export async function restoreFromGoogleDrive(mode = 'merge') {
  const stableId = getStableAccountId();
  if (!stableId) throw new Error('Not connected to Google — please reconnect.');

  const existing = await findExistingFile();
  if (!existing) throw new ValidationError('No Google Drive backup found for this profile.');

  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${existing.id}?alt=media`);
  const fileContent = await res.text();

  let container;
  try {
    container = JSON.parse(fileContent);
  } catch {
    throw new ValidationError('The Google Drive backup is corrupted or unreadable.');
  }
  if (!container.ciphertext || !container.salt || !container.iv) {
    throw new ValidationError('The Google Drive backup is corrupted or in an unrecognized format.');
  }

  let payload;
  try {
    const salt = base64ToBuf(container.salt);
    const iv = base64ToBuf(container.iv);
    const key = await deriveKey(stableId + APP_PEPPER, salt, 'decrypt');
    const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, base64ToBuf(container.ciphertext));
    payload = JSON.parse(new TextDecoder().decode(plaintextBuf));
  } catch {
    throw new ValidationError('Could not decrypt this backup — it may belong to a different Google account.');
  }

  if (!payload || typeof payload !== 'object' || !payload.stores) {
    throw new ValidationError('This backup is invalid or incompatible with this version of Finora.');
  }

  await restoreBackup(payload, mode);
  return { timestamp: container.timestamp, dbAppVersion: container.dbAppVersion };
}
