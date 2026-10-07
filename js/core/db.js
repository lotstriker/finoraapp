// ==========================================================================
// Finora — core/db.js
// IndexedDB is the financial source of truth (see 05 - Database & Data Model).
// This module owns schema creation only. All reads/writes go through
// core/ledger.js or a module file — nothing else should touch indexedDB
// directly, so balance/ledger consistency stays in one place.
//
// Schema migrations: bump DB_VERSION and add a new
// `if (event.oldVersion < N) { ... }` block inside onupgradeneeded for
// whatever changes ship in that version — new stores/indexes only ever
// get ADDED, never removed or renamed in place, so older code paths that
// haven't updated yet still find what they expect. Every store-creation
// call below is already guarded by `!db.objectStoreNames.contains(...)`,
// so this file is safe to re-run on every version bump; a new version's
// block only needs to add what's actually new (e.g. a new index on an
// existing store, via `event.target.transaction.objectStore('name')`,
// since `createIndex` requires the store's reference from the active
// upgrade transaction, not a fresh `createObjectStore` call).
// ==========================================================================

import { getActiveDbName } from '../modules/profiles.js';

export const DB_VERSION = 6;

let dbPromise = null;

/** Closes the cached connection so the next openDB() reopens (profile switch / tests simulating another device). */
export async function closeDB() {
  if (!dbPromise) return;
  try { (await dbPromise).close(); } catch { /* already closed */ }
  dbPromise = null;
}

/**
 * Opens (and lazily creates) the active profile's Finora IndexedDB
 * database. Safe to call many times — the connection is cached.
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (dbPromise) return dbPromise;

  const DB_NAME = getActiveDbName();
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // accounts — places money is held (07 - Accounts)
      if (!db.objectStoreNames.contains('accounts')) {
        const store = db.createObjectStore('accounts', { keyPath: 'id' });
        store.createIndex('type', 'type');
        store.createIndex('archived', 'archived');
      }

      // ledger — the master ledger, single source of truth for money movement (06)
      if (!db.objectStoreNames.contains('ledger')) {
        const store = db.createObjectStore('ledger', { keyPath: 'id' });
        store.createIndex('accountId', 'accountId');
        store.createIndex('toAccountId', 'toAccountId');
        store.createIndex('date', 'date');
        store.createIndex('type', 'type');
        store.createIndex('module', 'module');
        store.createIndex('personId', 'personId');
        store.createIndex('status', 'status');
        store.createIndex('parentTransactionId', 'parentTransactionId');
      }

      // people — money relationships (11 - People)
      if (!db.objectStoreNames.contains('people')) {
        const store = db.createObjectStore('people', { keyPath: 'id' });
        store.createIndex('archived', 'archived');
      }

      // categories — income/expense categories (08, 09)
      if (!db.objectStoreNames.contains('categories')) {
        const store = db.createObjectStore('categories', { keyPath: 'id' });
        store.createIndex('kind', 'kind'); // 'income' | 'expense'
        store.createIndex('archived', 'archived');
      }

      // loans + installments (15 - Loans & EMI)
      if (!db.objectStoreNames.contains('loans')) {
        db.createObjectStore('loans', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('loan_installments')) {
        const store = db.createObjectStore('loan_installments', { keyPath: 'id' });
        store.createIndex('loanId', 'loanId');
      }

      // committees / Bid & Save (12, 13, 14)
      if (!db.objectStoreNames.contains('committees')) {
        db.createObjectStore('committees', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('committee_memberships')) {
        const store = db.createObjectStore('committee_memberships', { keyPath: 'id' });
        store.createIndex('committeeId', 'committeeId');
      }
      if (!db.objectStoreNames.contains('committee_cycles')) {
        const store = db.createObjectStore('committee_cycles', { keyPath: 'id' });
        store.createIndex('committeeId', 'committeeId');
      }

      // savings — each goal keeps its own balance, no shared pool (16, locked audit 1.4)
      if (!db.objectStoreNames.contains('savings_goals')) {
        db.createObjectStore('savings_goals', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('savings_contributions')) {
        const store = db.createObjectStore('savings_contributions', { keyPath: 'id' });
        store.createIndex('goalId', 'goalId');
      }

      // recurring rules (17)
      if (!db.objectStoreNames.contains('recurring_rules')) {
        db.createObjectStore('recurring_rules', { keyPath: 'id' });
      }

      // settings — key/value store; also used for the ledger id counter
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }

      // v2: budgets — per-category monthly spending limits (Monthly Budgets)
      if (event.oldVersion < 2 && !db.objectStoreNames.contains('budgets')) {
        const store = db.createObjectStore('budgets', { keyPath: 'id' });
        store.createIndex('category', 'category');
      }

      // v3: scheduled_transactions — one-time future transactions the user
      // plans ahead (e.g. "salary on the 15th"), distinct from Recurring
      // rules which repeat. Never touches the ledger until recorded.
      if (event.oldVersion < 3 && !db.objectStoreNames.contains('scheduled_transactions')) {
        const store = db.createObjectStore('scheduled_transactions', { keyPath: 'id' });
        store.createIndex('scheduledDate', 'scheduledDate');
        store.createIndex('status', 'status');
      }

      // v4: bill_splits — groups a real expense transaction with the
      // per-person "lend" entries created for each participant's share,
      // purely for display; the actual debt tracking reuses People.
      if (event.oldVersion < 4 && !db.objectStoreNames.contains('bill_splits')) {
        db.createObjectStore('bill_splits', { keyPath: 'id' });
      }

      // v5: investments — FD/Mutual Fund/Stocks/Gold/etc. tracking.
      // investedAmount leaves an account as a real ledger transaction;
      // currentValue is a manually-updated estimate with no ledger effect.
      // sync_meta — DEVICE-LOCAL server-sync bookkeeping: for every synced record, the server revision we last
      // saw and a hash of what we last pushed/applied. Deliberately NOT in ALL_STORES, so it is never exported
      // in a backup nor overwritten by a restore (another device's bookkeeping would be wrong here).
      if (event.oldVersion < 6 && !db.objectStoreNames.contains('sync_meta')) {
        db.createObjectStore('sync_meta', { keyPath: 'key' });
      }

      if (event.oldVersion < 5 && !db.objectStoreNames.contains('investments')) {
        const store = db.createObjectStore('investments', { keyPath: 'id' });
        store.createIndex('status', 'status');
      }
    };

    request.onsuccess = (event) => {
      clearTimeout(blockedTimer);
      const db = event.target.result;
      // If another tab upgrades the schema, close this connection instead of
      // blocking that upgrade (then reopen lazily on the next call).
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    request.onerror = (event) => reject(event.target.error);
    // "blocked" only means another tab still holds the old version; that tab now closes itself
    // (onversionchange below), so wait a few seconds before giving up instead of failing instantly.
    let blockedTimer;
    request.onblocked = () => {
      blockedTimer = setTimeout(() => reject(new Error('Database upgrade blocked — close other Finora tabs.')), 5000);
    };
  });

  return dbPromise;
}

/* ---------- change signal (drives automatic cloud backup) ---------- */
const changeListeners = new Set();

/** Calls `fn(storeNames)` after EVERY committed write transaction (except `quiet` ones). Returns an unsubscribe fn. */
export function onDataChanged(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function emitDataChanged(storeNames) {
  for (const fn of changeListeners) {
    try { fn(storeNames); } catch { /* a listener must never break a save */ }
  }
}

/**
 * Runs `fn` inside a single atomic IDB transaction across `storeNames`.
 * `fn` receives the transaction object and must use it synchronously
 * (per IDB rules) — no awaiting other promises inside `fn` except the
 * IDB request helpers below.
 * @param {string[]} storeNames
 * @param {'readonly'|'readwrite'} mode
 * @param {(tx: IDBTransaction) => void|Promise<void>} fn
 * @param {{quiet?: boolean}} [options] quiet: bookkeeping writes (sync markers, logs) that
 *        must NOT count as "your data changed" — otherwise backing up would trigger a backup.
 */
export async function withTransaction(storeNames, mode, fn, { quiet = false } = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;

    tx.oncomplete = () => {
      if (mode === 'readwrite' && !quiet) emitDataChanged(storeNames);   // only AFTER the commit succeeded
      resolve(result);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));

    Promise.resolve(fn(tx))
      .then((r) => { result = r; })
      .catch((err) => {
        try { tx.abort(); } catch (_) { /* already aborted */ }
        reject(err);
      });
  });
}

/** Wraps an IDBRequest in a Promise. */
export function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const ALL_STORES = [
  'accounts', 'ledger', 'people', 'categories', 'loans', 'loan_installments',
  'committees', 'committee_memberships', 'committee_cycles',
  'savings_goals', 'savings_contributions', 'recurring_rules', 'settings', 'budgets',
  'scheduled_transactions', 'bill_splits', 'investments',
];

/** Convenience: get a single record by id from a store (own short transaction). */
export async function getById(storeName, id) {
  return withTransaction([storeName], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(storeName).get(id))
  );
}

/** Convenience: get all records from a store (own short transaction). */
export async function getAll(storeName) {
  return withTransaction([storeName], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(storeName).getAll())
  );
}

/** Removes every record from a store — used by Restore (replace mode) only. */
export async function clearStore(storeName) {
  return withTransaction([storeName], 'readwrite', (tx) =>
    reqToPromise(tx.objectStore(storeName).clear())
  );
}

/** Bulk-inserts records into a store inside one transaction. */
export async function putAll(storeName, records) {
  return withTransaction([storeName], 'readwrite', (tx) => {
    const store = tx.objectStore(storeName);
    records.forEach((r) => store.put(r));
  });
}
