// ==========================================================================
// Finora — modules/backup.js
// Locked crypto choices (20): AES-256-GCM, PBKDF2 key derivation, random
// salt + IV, via the browser's native Web Crypto API — no custom/weak
// (e.g. XOR) encryption.
// ==========================================================================

import { getAll, ALL_STORES, withTransaction, reqToPromise } from '../core/db.js';
import { ValidationError } from '../core/ledger.js';

const PBKDF2_ITERATIONS = 250000;
const BACKUP_VERSION = 2;

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function base64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function deriveKey(password, saltBuf, usage) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBuf, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  );
}

/** Gathers every store into one plain object, keyed by store name. */
async function exportAllStores() {
  const data = {};
  for (const name of ALL_STORES) {
    data[name] = await getAll(name);
  }
  return data;
}

/**
 * Produces the encrypted backup file content (a JSON string) for download.
 * @param {string} password
 */
export async function createEncryptedBackup(password) {
  if (!password || password.length < 8) {
    throw new ValidationError('Choose a backup password of at least 8 characters.');
  }

  const stores = await exportAllStores();
  const plaintext = new TextEncoder().encode(JSON.stringify({ stores, exportedAt: new Date().toISOString() }));

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, 'encrypt');
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  const container = {
    version: BACKUP_VERSION,
    algorithm: 'AES-256-GCM',
    kdf: 'PBKDF2',
    iterations: PBKDF2_ITERATIONS,
    salt: bufToBase64(salt),
    iv: bufToBase64(iv),
    ciphertext: bufToBase64(ciphertext),
    timestamp: new Date().toISOString(),
  };

  return JSON.stringify(container);
}

/**
 * Decrypts a backup file's content. A wrong password or corrupted file
 * fails cleanly with a ValidationError (20 — "must fail cleanly").
 * @param {string} fileText raw content of the uploaded backup file
 * @param {string} password
 * @returns {Promise<object>} the decrypted { stores, exportedAt } payload
 */
export async function decryptBackup(fileText, password) {
  let container;
  try {
    container = JSON.parse(fileText);
  } catch {
    throw new ValidationError('This does not look like a valid Finora backup file.');
  }
  if (!container.ciphertext || !container.salt || !container.iv) {
    throw new ValidationError('This does not look like a valid Finora backup file.');
  }

  try {
    const salt = base64ToBuf(container.salt);
    const iv = base64ToBuf(container.iv);
    const key = await deriveKey(password, salt, 'decrypt');
    const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, base64ToBuf(container.ciphertext));
    const json = new TextDecoder().decode(plaintextBuf);
    const payload = JSON.parse(json);
    if (!payload || typeof payload !== 'object' || !payload.stores || typeof payload.stores !== 'object') {
      throw new ValidationError('This backup file is invalid or incompatible with this version of Finora.');
    }
    return payload;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError('Incorrect password, or the backup file is corrupted.');
  }
}

/**
 * Applies a decrypted backup payload to the live database.
 * @param {object} payload the { stores } object from decryptBackup()
 * @param {'replace'|'merge'} mode
 *   replace — every store is cleared, then the backup's records are inserted.
 *   merge   — existing records are kept; incoming records with an ID that
 *             already exists are skipped (never blindly duplicated/overwritten).
 */
export async function restoreBackup(payload, mode) {
  if (!payload?.stores) throw new ValidationError('Backup payload is empty or invalid.');

  return withTransaction(ALL_STORES, 'readwrite', async (tx) => {
    for (const name of ALL_STORES) {
      const incoming = payload.stores[name] || [];
      const store = tx.objectStore(name);

      if (mode === 'replace') {
        await reqToPromise(store.clear());
        incoming.forEach((r) => store.put(r));
      } else {
        if (incoming.length === 0) continue;
        const existing = await reqToPromise(store.getAll());
        const existingIds = new Set(existing.map((r) => r.id ?? r.key));
        incoming
          .filter((r) => !existingIds.has(r.id ?? r.key))
          .forEach((r) => store.put(r));
      }
    }
  });
}

/**
 * Permanently erases every Finora store — accounts, ledger, everything.
 * One atomic transaction; irreversible. The caller (Settings UI) is
 * responsible for a strong confirmation step before calling this.
 */
export async function deleteAllData() {
  return withTransaction(ALL_STORES, 'readwrite', async (tx) => {
    for (const name of ALL_STORES) {
      await reqToPromise(tx.objectStore(name).clear());
    }
  });
}

export function downloadTextFile(filename, text, mimeType = 'application/json') {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------------------- */
/* CSV export — separate from the encrypted backup, for human/Excel use   */
/* ---------------------------------------------------------------------- */

function toCsv(rows, columns) {
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => escape(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => escape(c.get(row))).join(','));
  return [header, ...lines].join('\n');
}

/**
 * @param {'transactions'|'income'|'expenses'} kind
 */
export async function exportCsv(kind) {
  const [all, accounts, people] = await Promise.all([
    getAll('ledger'), getAll('accounts'), getAll('people'),
  ]);
  const accountsById = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  const peopleById = Object.fromEntries(people.map((p) => [p.id, p.name]));

  const rows = kind === 'income' ? all.filter((t) => t.type === 'income')
    : kind === 'expenses' ? all.filter((t) => t.type === 'expense')
    : all;

  const csv = toCsv(rows.sort((a, b) => new Date(b.date) - new Date(a.date)), [
    { label: 'Transaction ID', get: (r) => r.id },
    { label: 'Date', get: (r) => new Date(r.date).toISOString().slice(0, 10) },
    { label: 'Type', get: (r) => r.type },
    { label: 'Module', get: (r) => r.module || '' },
    { label: 'Account', get: (r) => accountsById[r.accountId] || '' },
    { label: 'To Account', get: (r) => (r.toAccountId ? accountsById[r.toAccountId] || '' : '') },
    { label: 'Person', get: (r) => (r.personId ? peopleById[r.personId] || '' : '') },
    { label: 'Category', get: (r) => r.category || '' },
    { label: 'Description', get: (r) => r.description || '' },
    { label: 'Amount', get: (r) => r.amount },
    { label: 'Direction', get: (r) => r.direction },
    { label: 'Status', get: (r) => r.status },
    { label: 'Parent Transaction ID', get: (r) => r.parentTransactionId || '' },
  ]);

  downloadTextFile(`finora-${kind}-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv');
}
