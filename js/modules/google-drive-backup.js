// ==========================================================================
// Finora — modules/google-drive-backup.js
//
// Google Drive App Data backup for Finora.
//
// IMPORTANT DESIGN:
// Google Drive's appDataFolder is already private to the connected Google
// account. Therefore the backup identity must NOT depend on the local
// Finora profile ID, because local profile IDs can differ between devices.
//
// NEW MULTI-DEVICE DESIGN:
//   One Google account -> one Finora cloud backup file
//
// This means:
//
//   PC  -> Google Account A -> finora-google-backup.json
//   Phone -> Google Account A -> same finora-google-backup.json
//
// The backup encryption key is still derived from the Google account's
// stable ID, so the same Google account can decrypt the backup on another
// device.
//
// LEGACY COMPATIBILITY:
// Older Finora versions created:
//   finora-backup-{localProfileId}.json
//
// Restore/backup will still look for the old profile-based file if the new
// account-based file does not exist. When a new backup is made, the new
// account-based file is used.
//
// ==========================================================================

import {
  exportAllStores,
  deriveKey,
  bufToBase64,
  base64ToBuf,
  PBKDF2_ITERATIONS,
  BACKUP_VERSION,
  restoreBackup,
  recordBackupCompleted,
} from './backup.js';

import {
  getAccessToken,
  getStableAccountId,
} from './google-auth.js';

import { getActiveProfile } from './profiles.js';
import { DB_VERSION } from '../core/db.js';
import { ValidationError } from '../core/ledger.js';

// --------------------------------------------------------------------------
// Security / key derivation
// --------------------------------------------------------------------------

// Fixed, non-secret domain-separation string.
//
// This is intentionally kept compatible with the previous implementation so
// backups created before this file change can still be decrypted using the
// same Google account.
const APP_PEPPER = 'finora-gdrive-backup-v1';

// --------------------------------------------------------------------------
// Backup filenames
// --------------------------------------------------------------------------

// NEW:
// App Data is already isolated per Google account, so a fixed filename is
// enough to identify the Finora backup for that Google account.
//
// This is what makes the backup device-independent.
const CLOUD_BACKUP_FILE_NAME = 'finora-google-backup.json';

// OLD:
// Previous versions used the local Finora profile ID.
//
// We keep this only for backwards compatibility.
function legacyBackupFileName() {
  const profile = getActiveProfile();

  if (!profile?.id) {
    return null;
  }

  return `finora-backup-${profile.id}.json`;
}

// --------------------------------------------------------------------------
// Google Drive request helper
// --------------------------------------------------------------------------

async function driveFetch(url, options = {}) {
  const token = getAccessToken();

  if (!token) {
    throw new Error('Not connected to Google — please reconnect.');
  }

  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 401) {
    throw new Error(
      'Your Google session expired — please reconnect.'
    );
  }

  if (!res.ok) {
    throw new Error(
      `Google Drive request failed (${res.status}).`
    );
  }

  return res;
}

// --------------------------------------------------------------------------
// Find backup by filename
// --------------------------------------------------------------------------

async function findFileByName(name) {
  if (!name) {
    return null;
  }

  // Escape single quotes for Google Drive's query syntax.
  const escapedName = name.replace(/'/g, "\\'");

  const url =
    `https://www.googleapis.com/drive/v3/files` +
    `?spaces=appDataFolder` +
    `&q=name%3D%27${encodeURIComponent(escapedName)}%27` +
    `&fields=files(id,name,modifiedTime)` +
    `&pageSize=10`;

  const res = await driveFetch(url);
  const data = await res.json();

  if (!data.files || data.files.length === 0) {
    return null;
  }

  return data.files[0];
}

// --------------------------------------------------------------------------
// Find the current Google-account backup
// --------------------------------------------------------------------------

/**
 * Finds the new account-based backup first.
 *
 * If it doesn't exist, falls back to the old local-profile-based backup.
 *
 * Returns:
 *   {
 *     file,
 *     type: 'cloud' | 'legacy'
 *   }
 *
 * or null.
 */
async function findExistingFile() {
  // ------------------------------------------------------------
  // 1. New multi-device backup
  // ------------------------------------------------------------

  const cloudFile = await findFileByName(
    CLOUD_BACKUP_FILE_NAME
  );

  if (cloudFile) {
    return {
      file: cloudFile,
      type: 'cloud',
    };
  }

  // ------------------------------------------------------------
  // 2. Legacy backup
  // ------------------------------------------------------------

  const legacyName = legacyBackupFileName();

  if (legacyName) {
    const legacyFile = await findFileByName(legacyName);

    if (legacyFile) {
      return {
        file: legacyFile,
        type: 'legacy',
      };
    }
  }

  return null;
}

// --------------------------------------------------------------------------
// Create encrypted backup container
// --------------------------------------------------------------------------

async function createBackupContainer(stableId) {
  const stores = await exportAllStores();

  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      stores,
      exportedAt: new Date().toISOString(),
    })
  );

  // Every backup gets a fresh salt and IV.
  const salt = crypto.getRandomValues(
    new Uint8Array(16)
  );

  const iv = crypto.getRandomValues(
    new Uint8Array(12)
  );

  // IMPORTANT:
  // Same Google account -> same stable ID -> same derived key.
  //
  // The salt is stored inside the backup and therefore doesn't need to be
  // the same between backups.
  const key = await deriveKey(
    stableId + APP_PEPPER,
    salt,
    'encrypt'
  );

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    plaintext
  );

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

    // Helpful metadata for debugging / future migrations.
    keySource: 'google-account',
    storageIdentity: 'google-account',
  };
}

// --------------------------------------------------------------------------
// Create a new Drive file
// --------------------------------------------------------------------------

async function createDriveFile(fileName, fileContent) {
  const metadata = {
    name: fileName,
    parents: ['appDataFolder'],
  };

  const boundary =
    'finora-boundary-' + Date.now();

  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${fileContent}\r\n` +
    `--${boundary}--`;

  return driveFetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        'Content-Type':
          `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    }
  );
}

// --------------------------------------------------------------------------
// Update an existing Drive file
// --------------------------------------------------------------------------

async function updateDriveFile(fileId, fileContent) {
  return driveFetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: fileContent,
    }
  );
}

// --------------------------------------------------------------------------
// Backup
// --------------------------------------------------------------------------

/**
 * Backs up the active Finora data to the connected Google account.
 *
 * NEW behavior:
 *   Always writes to:
 *
 *   finora-google-backup.json
 *
 * This filename is independent of the local Finora profile ID, so the same
 * Google account can find the same backup from another device.
 */
export async function backupToGoogleDrive() {
  const stableId = getStableAccountId();

  if (!stableId) {
    throw new Error(
      'Not connected to Google — please reconnect.'
    );
  }

  // Create encrypted backup.
  const container =
    await createBackupContainer(stableId);

  const fileContent =
    JSON.stringify(container);

  // ------------------------------------------------------------
  // Look for the new account-based backup.
  // ------------------------------------------------------------

  const cloudFile =
    await findFileByName(CLOUD_BACKUP_FILE_NAME);

  if (cloudFile) {
    // Update the existing account-based backup.
    await updateDriveFile(
      cloudFile.id,
      fileContent
    );
  } else {
    // ----------------------------------------------------------
    // No new backup exists.
    //
    // IMPORTANT:
    // We deliberately create the new account-based backup instead
    // of overwriting the old legacy file.
    //
    // This preserves the old backup until the new backup is known
    // to be working correctly.
    // ----------------------------------------------------------

    await createDriveFile(
      CLOUD_BACKUP_FILE_NAME,
      fileContent
    );
  }

  await recordBackupCompleted();

  return {
    timestamp: container.timestamp,
  };
}

// --------------------------------------------------------------------------
// Backup information
// --------------------------------------------------------------------------

/**
 * Returns information about the available Google Drive backup.
 *
 * New account-based backup is preferred.
 * Legacy backup is returned only if the new one doesn't exist.
 */
export async function getGoogleDriveBackupInfo() {
  const existing =
    await findExistingFile();

  if (!existing) {
    return null;
  }

  return {
    modifiedTime:
      existing.file.modifiedTime,

    fileId:
      existing.file.id,

    storageType:
      existing.type,
  };
}

// --------------------------------------------------------------------------
// Download backup
// --------------------------------------------------------------------------

async function downloadBackupFile(fileId) {
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`
  );

  return res.text();
}

// --------------------------------------------------------------------------
// Parse + decrypt backup
// --------------------------------------------------------------------------

async function decryptBackup(
  fileContent,
  stableId
) {
  let container;

  // ------------------------------------------------------------
  // Parse JSON
  // ------------------------------------------------------------

  try {
    container = JSON.parse(fileContent);
  } catch {
    throw new ValidationError(
      'The Google Drive backup is corrupted or unreadable.'
    );
  }

  // ------------------------------------------------------------
  // Validate encrypted container
  // ------------------------------------------------------------

  if (
    !container ||
    !container.ciphertext ||
    !container.salt ||
    !container.iv
  ) {
    throw new ValidationError(
      'The Google Drive backup is corrupted or in an unrecognized format.'
    );
  }

  // ------------------------------------------------------------
  // Decrypt
  // ------------------------------------------------------------

  try {
    const salt =
      base64ToBuf(container.salt);

    const iv =
      base64ToBuf(container.iv);

    // Same Google account -> same stableId -> same key.
    const key = await deriveKey(
      stableId + APP_PEPPER,
      salt,
      'decrypt'
    );

    const plaintextBuf =
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv,
        },
        key,
        base64ToBuf(container.ciphertext)
      );

    return JSON.parse(
      new TextDecoder().decode(
        plaintextBuf
      )
    );
  } catch {
    throw new ValidationError(
      'Could not decrypt this backup — it may belong to a different Google account.'
    );
  }
}

// --------------------------------------------------------------------------
// Restore
// --------------------------------------------------------------------------

/**
 * Downloads and restores the backup belonging to the connected Google
 * account.
 *
 * IMPORTANT:
 * The active local profile ID is NOT used to find the new cloud backup.
 *
 * This is what enables:
 *
 *   PC profile ID A
 *          ↓
 *     Google account
 *          ↓
 *   Mobile profile ID B
 *
 * to restore the same backup.
 */
export async function restoreFromGoogleDrive(
  mode = 'merge'
) {
  const stableId = getStableAccountId();

  if (!stableId) {
    throw new Error(
      'Not connected to Google — please reconnect.'
    );
  }

  // Find account-based backup first, then legacy backup.
  const existing =
    await findExistingFile();

  if (!existing) {
    throw new ValidationError(
      'No Google Drive backup found for this Google account.'
    );
  }

  // Download.
  const fileContent =
    await downloadBackupFile(
      existing.file.id
    );

  // Decrypt.
  const payload =
    await decryptBackup(
      fileContent,
      stableId
    );

  // Validate decrypted payload.
  if (
    !payload ||
    typeof payload !== 'object' ||
    !payload.stores
  ) {
    throw new ValidationError(
      'This backup is invalid or incompatible with this version of Finora.'
    );
  }

  // Apply through the existing tested restore system.
  await restoreBackup(
    payload,
    mode
  );

  return {
    timestamp:
      existing.file.modifiedTime,

    dbAppVersion:
      payload.dbAppVersion ??
      null,

    storageType:
      existing.type,
  };
}