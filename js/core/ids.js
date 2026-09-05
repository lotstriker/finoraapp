// ==========================================================================
// Finora — core/ids.js
// Ledger transaction IDs must be unique + stable (06 - Master Ledger).
// Format: TXN-{year}-{6-digit sequence, resets each year}.
// Counter lives in the settings store so it is generated inside the same
// atomic transaction as the ledger write.
// ==========================================================================

const COUNTER_KEY = 'ledgerCounter';

/**
 * Reads+increments the ledger counter for the current year, inside the
 * caller's existing IDB transaction (must include 'settings' in its scope).
 * @param {IDBTransaction} tx
 * @returns {Promise<string>} e.g. "TXN-2026-000184"
 */
export function nextTransactionId(tx) {
  const year = new Date().getFullYear();
  const store = tx.objectStore('settings');

  return new Promise((resolve, reject) => {
    const getReq = store.get(COUNTER_KEY);
    getReq.onerror = () => reject(getReq.error);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      const sameYear = existing && existing.year === year;
      const nextSeq = sameYear ? existing.seq + 1 : 1;

      const putReq = store.put({ key: COUNTER_KEY, year, seq: nextSeq });
      putReq.onerror = () => reject(putReq.error);
      putReq.onsuccess = () => {
        const padded = String(nextSeq).padStart(6, '0');
        resolve(`TXN-${year}-${padded}`);
      };
    };
  });
}

/** Generic entity id (accounts, people, categories, etc.) — not ledger. */
export function newId(prefix = 'id') {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}_${Date.now().toString(36)}${rand[0].toString(36)}${rand[1].toString(36)}`;
}
