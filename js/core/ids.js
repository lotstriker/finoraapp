// ==========================================================================
// Finora — core/ids.js
// Ledger transaction IDs must be unique + stable (06 - Master Ledger).
// Format: TXN-{year}-{6-digit sequence, resets each year}-{4-char device id}.
// The device suffix keeps ids unique ACROSS devices, so merging a phone and a
// PC backup can never collide. Old ids without the suffix are still valid.
// Counter lives in the settings store so it is generated inside the same
// atomic transaction as the ledger write.
// ==========================================================================

export const COUNTER_KEY = 'ledgerCounter';
export const DEVICE_KEY = 'deviceId';

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
    // Counter + device suffix are read in the SAME transaction. The suffix
    // makes ids unique ACROSS devices (PC "TXN-2026-000001-k3x9" can never
    // collide with phone "TXN-2026-000001-p7a2" when backups are merged).
    const devReq = store.get(DEVICE_KEY);
    devReq.onerror = () => reject(devReq.error);
    devReq.onsuccess = () => {
      let device = devReq.result?.value;
      if (!device) {
        const rand = crypto.getRandomValues(new Uint32Array(1))[0];
        device = rand.toString(36).slice(0, 4).padEnd(4, '0');
        store.put({ key: DEVICE_KEY, value: device });
      }

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
          resolve(`TXN-${year}-${padded}-${device}`);
        };
      };
    };
  });
}

/** Parses "TXN-2026-000184" or "TXN-2026-000184-k3x9" -> { year, seq } (or null). */
export function parseTransactionId(id) {
  const m = /^TXN-(\d{4})-(\d{6})(?:-[a-z0-9]+)?$/i.exec(id || '');
  return m ? { year: Number(m[1]), seq: Number(m[2]) } : null;
}

/** Generic entity id (accounts, people, categories, etc.) — not ledger. */
export function newId(prefix = 'id') {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}_${Date.now().toString(36)}${rand[0].toString(36)}${rand[1].toString(36)}`;
}
