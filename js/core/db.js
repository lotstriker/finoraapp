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

const DB_NAME = 'finora';
const DB_VERSION = 1;

let dbPromise = null;

/**
 * Opens (and lazily creates) the Finora IndexedDB database.
 * Safe to call many times — the connection is cached.
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (dbPromise) return dbPromise;

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
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
    request.onblocked = () => reject(new Error('Database upgrade blocked — close other Finora tabs.'));
  });

  return dbPromise;
}

/**
 * Runs `fn` inside a single atomic IDB transaction across `storeNames`.
 * `fn` receives the transaction object and must use it synchronously
 * (per IDB rules) — no awaiting other promises inside `fn` except the
 * IDB request helpers below.
 * @param {string[]} storeNames
 * @param {'readonly'|'readwrite'} mode
 * @param {(tx: IDBTransaction) => void|Promise<void>} fn
 */
export async function withTransaction(storeNames, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;

    tx.oncomplete = () => resolve(result);
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
  'savings_goals', 'savings_contributions', 'recurring_rules', 'settings',
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
