// ==========================================================================
// Finora — modules/backup.js
// Locked crypto choices (20): AES-256-GCM, PBKDF2 key derivation, random
// salt + IV, via the browser's native Web Crypto API — no custom/weak
// (e.g. XOR) encryption.
// ==========================================================================

import { getAll, getById, ALL_STORES, withTransaction, reqToPromise } from '../core/db.js';
import { nextTransactionId, parseTransactionId, COUNTER_KEY, DEVICE_KEY } from '../core/ids.js';
import { roundMoney } from '../utils/currency.js';
import { ValidationError } from '../core/ledger.js';
import { getSetting, setSetting } from './preferences.js';

const LAST_BACKUP_KEY = 'lastBackupAt';
const BACKUP_REMINDER_DAYS = 14;

// OWASP Password Storage Cheat Sheet: PBKDF2-HMAC-SHA256 => 600,000 iterations.
// Older backups used 250,000 and store their own count in the container, so
// decrypt always uses the count written in the file (LEGACY_PBKDF2_ITERATIONS
// is only the fallback for containers that have no `iterations` field).
export const PBKDF2_ITERATIONS = 600000;
export const LEGACY_PBKDF2_ITERATIONS = 250000;
export const BACKUP_VERSION = 2;

export function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

export function base64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function deriveKey(password, saltBuf, usage, iterations = PBKDF2_ITERATIONS) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBuf, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  );
}

/** Gathers every store into one plain object, keyed by store name. */
export async function exportAllStores() {
  const data = {};
  for (const name of ALL_STORES) {
    data[name] = await getAll(name);
  }
  // Device-only bookkeeping (this device's id + its cloud-sync marker) must never
  // travel inside a backup, or restoring would make two devices look identical.
  data.settings = (data.settings || []).filter((s) => !DEVICE_LOCAL_KEYS.has(s.key));
  return data;
}

/* ---------- dataset id: identifies THIS profile's data across devices ---------- */
export const DATASET_KEY = 'datasetId';
export const CLOUD_SYNC_KEY = 'cloudSync';
export const AUTO_SYNC_KEY = 'autoSync';
export const CLOUD_DIRTY_KEY = 'cloudDirty';
export const CLOUD_START_FRESH_KEY = 'cloudStartFresh';
export const E2E_KEY_STORE = 'e2eKey';
export const SERVER_SYNC_ENABLED_KEY = 'serverSyncEnabled';
// Per-device state: never exported in backups and never overwritten by a restore.
const DEVICE_LOCAL_KEYS = new Set([DEVICE_KEY, CLOUD_SYNC_KEY, AUTO_SYNC_KEY, CLOUD_DIRTY_KEY, CLOUD_START_FRESH_KEY, E2E_KEY_STORE, SERVER_SYNC_ENABLED_KEY]);

/**
 * A random id that names this profile's DATA (not this device). It IS included in
 * backups, so a phone that restores the PC's backup adopts the same id — and both
 * then sync to the same cloud file, while a second profile gets its own id and its
 * own cloud file (it can no longer overwrite the first one's).
 */
export async function getDatasetId() {
  return withTransaction(['settings'], 'readwrite', async (tx) => {
    const store = tx.objectStore('settings');
    const existing = await reqToPromise(store.get(DATASET_KEY));
    if (existing?.value) return existing.value;
    const bytes = crypto.getRandomValues(new Uint8Array(9));
    const id = 'ds_' + [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
    store.put({ key: DATASET_KEY, value: id });
    return id;
  }, { quiet: true });
}

export async function setDatasetId(id) {
  return withTransaction(['settings'], 'readwrite', (tx) => { tx.objectStore('settings').put({ key: DATASET_KEY, value: id }); }, { quiet: true });
}

/** This device's short random id (created on first use). Sent with every sync write so a device can recognise its own echoes. */
export async function getDeviceId() {
  return withTransaction(['settings'], 'readwrite', async (tx) => {
    const store = tx.objectStore('settings');
    const existing = await reqToPromise(store.get(DEVICE_KEY));
    if (existing?.value) return existing.value;
    const device = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 4).padEnd(4, '0');
    store.put({ key: DEVICE_KEY, value: device });
    return device;
  }, { quiet: true });
}

/** What this device last saw in the cloud: {datasetId, fileId, modifiedTime, at} or null. */
export async function getCloudSync() {
  const rec = await getById('settings', CLOUD_SYNC_KEY);
  return rec?.value || null;
}

export async function setCloudSync(value) {
  return withTransaction(['settings'], 'readwrite', (tx) => { tx.objectStore('settings').put({ key: CLOUD_SYNC_KEY, value }); }, { quiet: true });
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

/** Marks "now" as the last successful backup — called by the UI once the file has actually downloaded. */
export async function recordBackupCompleted() {
  await setSetting(LAST_BACKUP_KEY, new Date().toISOString());
}

/**
 * Tells the UI whether a backup reminder should show, and how long it's
 * been. Returns null if a backup was made recently (or restore/first-run
 * data exists but no backup yet and there's nothing worth backing up).
 */
export async function getBackupReminderStatus() {
  const lastBackupAt = await getSetting(LAST_BACKUP_KEY, null);
  const accounts = await getAll('accounts');
  if (accounts.length === 0) return null; // nothing to back up yet

  if (!lastBackupAt) {
    return { daysSince: null, overdue: true, message: "You haven't backed up Finora yet." };
  }
  const daysSince = Math.floor((Date.now() - new Date(lastBackupAt).getTime()) / 86400000);
  if (daysSince < BACKUP_REMINDER_DAYS) return null;
  return { daysSince, overdue: true, message: `It's been ${daysSince} days since your last backup.` };
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
    const key = await deriveKey(password, salt, 'decrypt', Number(container.iterations) || LEGACY_PBKDF2_ITERATIONS);
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

const DEVICE_ONLY_SETTINGS = new Set([DEVICE_KEY, COUNTER_KEY, ...DEVICE_LOCAL_KEYS]);

/** Fields that identify "the same ledger row" when two ids collide. */
function sameLedgerRow(a, b) {
  return ['createdAt', 'type', 'direction', 'amount', 'date', 'accountId', 'toAccountId', 'personId', 'description']
    .every((k) => (a[k] ?? null) === (b[k] ?? null));
}

/** Deep-replaces ids inside an incoming record (exact values + "Reversal of <id>" text). */
export function remapIds(value, idMap, patterns) {
  if (typeof value === 'string') {
    if (idMap.has(value)) return idMap.get(value);
    let out = value;
    for (const [oldId, re] of patterns) out = out.replace(re, idMap.get(oldId));
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => remapIds(v, idMap, patterns));
  if (value && typeof value === 'object') {
    const o = {};
    for (const k of Object.keys(value)) o[k] = remapIds(value[k], idMap, patterns);
    return o;
  }
  return value;
}

function storeGetAll(tx, name) {
  return reqToPromise(tx.objectStore(name).getAll());
}

/**
 * Balances are DERIVED from the ledger, which is the source of truth. After a
 * merge the ledger may contain rows from another device, so every cached
 * balance (accounts, credit-card usage, people, savings goals) is recomputed
 * instead of trusting whichever copy of the account record happened to win.
 */
export async function recomputeBalancesInTx(tx) {
  const [ledger, accounts, people, goals] = await Promise.all([
    storeGetAll(tx, 'ledger'), storeGetAll(tx, 'accounts'), storeGetAll(tx, 'people'), storeGetAll(tx, 'savings_goals'),
  ]);
  const acc = new Map(accounts.map((a) => [a.id, 0]));
  const per = new Map(people.map((p) => [p.id, 0]));
  const goal = new Map(goals.map((g) => [g.id, 0]));

  for (const t of ledger) {
    if (t.direction === 'transfer') {
      if (acc.has(t.accountId)) acc.set(t.accountId, acc.get(t.accountId) - t.amount);
      if (acc.has(t.toAccountId)) acc.set(t.toAccountId, acc.get(t.toAccountId) + t.amount);
    } else {
      const sign = t.direction === 'in' ? 1 : -1;
      if (acc.has(t.accountId)) acc.set(t.accountId, acc.get(t.accountId) + sign * t.amount);
      if (t.personId && per.has(t.personId)) per.set(t.personId, per.get(t.personId) - sign * t.amount);
      if ((t.type === 'savings_contribution' || t.type === 'savings_withdrawal') && goal.has(t.moduleRef)) {
        goal.set(t.moduleRef, goal.get(t.moduleRef) - sign * t.amount);
      }
    }
  }

  const accStore = tx.objectStore('accounts');
  for (const a of accounts) {
    const bal = roundMoney(acc.get(a.id));
    if (a.type === 'credit_card') { a.usedAmount = roundMoney(-bal); a.balance = bal; } else { a.balance = bal; }
    accStore.put(a);
  }
  const perStore = tx.objectStore('people');
  for (const p of people) { p.balance = roundMoney(per.get(p.id)); perStore.put(p); }
  const goalStore = tx.objectStore('savings_goals');
  for (const g of goals) { g.currentAmount = Math.max(0, roundMoney(goal.get(g.id))); goalStore.put(g); }
}

/** Makes the ledger counter >= the highest sequence number present for this year. */
async function syncLedgerCounter(tx, ledgerRows) {
  const year = new Date().getFullYear();
  const settings = tx.objectStore('settings');
  const cur = await reqToPromise(settings.get(COUNTER_KEY));
  let max = cur && cur.year === year ? cur.seq : 0;
  for (const r of ledgerRows) {
    const p = parseTransactionId(r.id);
    if (p && p.year === year && p.seq > max) max = p.seq;
  }
  settings.put({ key: COUNTER_KEY, year, seq: max });
}

/**
 * Applies a decrypted backup payload to the live database — ONE atomic
 * transaction, so a failure part-way leaves the old data untouched.
 *
 *   replace — every store is cleared, then the backup's records are inserted.
 *             This device's own `deviceId` is kept so new ids stay unique.
 *   merge   — existing records are kept. For the ledger:
 *               * identical row already present  -> skipped (idempotent re-restore)
 *               * same id but DIFFERENT row (two devices both issued
 *                 TXN-2026-000001) -> the incoming row gets a fresh id and every
 *                 reference to it is remapped, instead of being silently dropped
 *               * the id counter is synced so new transactions can never
 *                 overwrite imported ones
 *             Categories/budgets already present by name are not duplicated.
 *             All cached balances are recomputed from the merged ledger.
 *   Known limit: if the SAME record (e.g. one loan installment) was changed on
 *   both devices, the local copy wins — merge is for additive data. Use Replace
 *   when you want one device to become an exact copy of the other.
 */
export async function restoreBackup(payload, mode, { quiet = false } = {}) {
  if (!payload?.stores) throw new ValidationError('Backup payload is empty or invalid.');
  if (mode !== 'replace' && mode !== 'merge') throw new ValidationError('Unknown restore mode.');

  return withTransaction([...ALL_STORES, 'sync_meta'], 'readwrite', async (tx) => {
    if (mode === 'replace') {
      const keepLocal = await Promise.all([...DEVICE_LOCAL_KEYS].map((k) => reqToPromise(tx.objectStore('settings').get(k))));
      for (const name of ALL_STORES) {
        const store = tx.objectStore(name);
        await reqToPromise(store.clear());
        (payload.stores[name] || []).forEach((r) => {
          if (name === 'settings' && DEVICE_LOCAL_KEYS.has(r.key)) return;
          store.put(r);
        });
      }
      keepLocal.filter(Boolean).forEach((r) => tx.objectStore('settings').put(r));
      // Replacing the data invalidates server-sync bookkeeping (see deleteAllData) — start it afresh.
      await reqToPromise(tx.objectStore('sync_meta').clear());
      await syncLedgerCounter(tx, payload.stores.ledger || []);
      await recomputeBalancesInTx(tx);
      return;
    }

    // ---- merge ----
    const incomingLedger = (payload.stores.ledger || []).map((r) => ({ ...r }));
    const localLedger = await storeGetAll(tx, 'ledger');
    const localById = new Map(localLedger.map((r) => [r.id, r]));

    await syncLedgerCounter(tx, [...localLedger, ...incomingLedger]);

    const idMap = new Map();
    const ledgerToInsert = [];
    for (const r of incomingLedger) {
      const existing = localById.get(r.id);
      if (!existing) { ledgerToInsert.push(r); continue; }
      if (sameLedgerRow(existing, r)) continue; // already here
      idMap.set(r.id, await nextTransactionId(tx)); // two DIFFERENT rows share one id
      ledgerToInsert.push(r);
    }
    const patterns = [...idMap.keys()].map((oldId) => [oldId, new RegExp(`${oldId}(?![\\w-])`, 'g')]);

    const ledgerStore = tx.objectStore('ledger');
    ledgerToInsert.forEach((r) => {
      const fixed = idMap.size ? remapIds(r, idMap, patterns) : r;
      ledgerStore.put(fixed);
    });

    for (const name of ALL_STORES) {
      if (name === 'ledger') continue;
      const incoming = payload.stores[name] || [];
      if (incoming.length === 0) continue;
      const store = tx.objectStore(name);
      const existing = await reqToPromise(store.getAll());
      const existingIds = new Set(existing.map((r) => r.id ?? r.key));
      const existingNames = new Set(
        name === 'categories' ? existing.map((c) => `${c.kind}:${c.name.toLowerCase()}`)
        : name === 'budgets' ? existing.map((b) => b.category) : []
      );

      for (const raw of incoming) {
        const key = raw.id ?? raw.key;
        if (existingIds.has(key)) continue;
        if (name === 'settings' && DEVICE_ONLY_SETTINGS.has(raw.key)) continue;
        if (name === 'categories' && existingNames.has(`${raw.kind}:${raw.name.toLowerCase()}`)) continue;
        if (name === 'budgets' && existingNames.has(raw.category)) continue;
        store.put(idMap.size ? remapIds(raw, idMap, patterns) : raw);
      }
    }

    await recomputeBalancesInTx(tx);
  }, { quiet });
}

/**
 * Permanently erases every Finora store — accounts, ledger, everything.
 * One atomic transaction; irreversible. The caller (Settings UI) is
 * responsible for a strong confirmation step before calling this.
 */
export async function deleteAllData() {
  return withTransaction([...ALL_STORES, 'sync_meta'], 'readwrite', async (tx) => {
    for (const name of ALL_STORES) {
      await reqToPromise(tx.objectStore(name).clear());
    }
    // Forget the server-sync bookkeeping too. If it survived, the sync engine would read "records I synced
    // are now missing" as "the user deleted them" and push tombstones that wipe every OTHER device's data.
    // Wiping this device is a local act; the data simply comes back from the server on the next sync.
    await reqToPromise(tx.objectStore('sync_meta').clear());
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
    let s = String(v ?? '');
    // CSV/formula injection (OWASP): a TEXT cell that starts with = + - @ (or tab/CR)
    // is executed as a formula by Excel/Sheets. A leading tab neutralises it.
    // Real numbers are left alone so "-250.00" amounts stay numeric.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `\t${s}`;
    return /[",\n\t\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => escape(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => escape(c.get(row))).join(','));
  return [header, ...lines].join('\n');
}

/**
 * @param {'transactions'|'income'|'expenses'} kind
 */
const localDay = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA') : '');   // local date, not the UTC one

/** Builds the CSV text for the non-transaction exports (accounts / loans / people / goals). */
export async function buildListCsv(kind) {
  if (kind === 'accounts') {
    const accounts = await getAll('accounts');
    return toCsv(accounts, [
      { label: 'Name', get: (a) => a.name }, { label: 'Type', get: (a) => a.type },
      { label: 'Balance', get: (a) => a.balance }, { label: 'Credit Limit', get: (a) => a.creditLimit ?? '' },
      { label: 'Used (credit card)', get: (a) => a.usedAmount ?? '' }, { label: 'Archived', get: (a) => (a.archived ? 'yes' : 'no') },
    ]);
  }
  if (kind === 'loans') {
    const [loans, installments] = await Promise.all([getAll('loans'), getAll('loan_installments')]);
    const loanName = Object.fromEntries(loans.map((l) => [l.id, l.name]));
    return toCsv(installments.sort((a, b) => (loanName[a.loanId] || '').localeCompare(loanName[b.loanId] || '') || a.installmentNumber - b.installmentNumber), [
      { label: 'Loan', get: (i) => loanName[i.loanId] || '' }, { label: 'Installment #', get: (i) => i.installmentNumber },
      { label: 'Due Date', get: (i) => localDay(i.dueDate) }, { label: 'EMI', get: (i) => i.amount },
      { label: 'Principal', get: (i) => i.principalComponent ?? '' }, { label: 'Interest', get: (i) => i.interestComponent ?? '' },
      { label: 'Status', get: (i) => i.status }, { label: 'Paid On', get: (i) => localDay(i.paidDate) },
    ]);
  }
  if (kind === 'people') {
    const people = await getAll('people');
    return toCsv(people, [
      { label: 'Name', get: (p) => p.name }, { label: 'Phone', get: (p) => p.phone || '' }, { label: 'Email', get: (p) => p.email || '' },
      { label: 'Balance (positive = they owe you)', get: (p) => p.balance }, { label: 'Notes', get: (p) => p.notes || '' },
    ]);
  }
  if (kind === 'goals') {
    const goals = await getAll('savings_goals');
    return toCsv(goals, [
      { label: 'Goal', get: (g) => g.name }, { label: 'Target', get: (g) => g.targetAmount }, { label: 'Saved', get: (g) => g.currentAmount },
      { label: 'Target Date', get: (g) => localDay(g.targetDate) }, { label: 'Priority', get: (g) => g.priority || '' },
    ]);
  }
  throw new ValidationError('Unknown export type.');
}

export async function exportCsv(kind) {
  if (['accounts', 'loans', 'people', 'goals'].includes(kind)) {
    downloadTextFile(`finora-${kind}-${localDay(new Date().toISOString())}.csv`, await buildListCsv(kind), 'text/csv');
    return;
  }
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
    { label: 'Date', get: (r) => localDay(r.date) },
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

  downloadTextFile(`finora-${kind}-${localDay(new Date().toISOString())}.csv`, csv, 'text/csv');
}
