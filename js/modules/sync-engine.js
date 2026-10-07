// ==========================================================================
// Finora — modules/sync-engine.js
// The record-level SYNC ENGINE for server sync (Supabase). No timers, no UI — see server-sync.js.
//
//   local IndexedDB  <──  pull  ──  server (ciphertext only)
//                    ──  push  ──►
//
// HOW IT WORKS
//  * IndexedDB stays the source of truth. For every synced record we remember (device-locally, in
//    `sync_meta`) the server revision we last saw + a HASH of what we last pushed/applied.
//  * "What changed locally?" = compare each record's hash to the remembered one (no instrumentation of
//    every write; robust against crashes). A remembered record that no longer exists locally = deleted.
//  * PULL first, then PUSH (fewer conflicts). Pull asks "everything after my cursor" in pages; push sends
//    batches through the atomic `sync_push()` function with the revision we based the edit on.
//  * Conflict (same record changed on two devices): the SERVER's newer version wins, and your overwritten
//    copy is kept in a local conflict log — never silently dropped.
//  * Derived numbers (account balances, people balances, goal totals) are NOT synced: devices would fight
//    over them. They are recomputed from the ledger after every pull.
//  * Records are encrypted (AES-GCM) before leaving the device; AAD pins each ciphertext to its record.
//  * Deletes are tombstones (see supabase/schema.sql for why).
//  * Realtime is only a hint; this file never trusts it for correctness.
// ==========================================================================

import { ALL_STORES, withTransaction, reqToPromise } from '../core/db.js';
import { remapIds, recomputeBalancesInTx } from './backup.js';
import { encryptValue, decryptValue, recordAad, E2EError } from './e2e-crypto.js';

export const PUSH_BATCH = 200;
export const PULL_PAGE = 500;
/** Re-read a few sequence numbers before the cursor: a transaction with a lower seq can commit AFTER one with a higher seq. */
export const PULL_OVERLAP = 50;
const META = 'sync_meta';
const CURSOR = '__cursor__';
const CONFLICTS = '__conflicts__';
const MIGRATED = '__migrated__';
export const MAX_CONFLICT_LOG = 50;

/**
 * True while the engine is writing REMOTE data into IndexedDB. The scheduler uses it to ignore those writes —
 * otherwise "data arrived from the server" would look like "the user edited something" and trigger another sync.
 */
let applyingRemote = 0;
export const isApplyingRemote = () => applyingRemote > 0;
async function whileApplying(fn) {
  applyingRemote += 1;
  try { return await fn(); } finally { applyingRemote -= 1; }
}

const SYNC_STORES = [...ALL_STORES];        // includes 'settings' (filtered below)
/** Settings that belong to THIS device / bookkeeping — never synced. */
const SETTINGS_EXCLUDE = new Set(['deviceId', 'cloudSync', 'autoSync', 'cloudDirty', 'cloudStartFresh', 'e2eKey', 'ledgerCounter', 'notifiedLog', 'lastBackupAt', 'datasetId', 'serverSyncEnabled']);
/** Fields computed from the ledger — excluded from hashes and payloads. */
const DERIVED = { accounts: ['balance', 'usedAmount'], people: ['balance'], savings_goals: ['currentAmount'] };
/** Stores whose cached numbers must be recomputed after remote data lands. */
const RECOMPUTE_AFTER = new Set(['ledger', 'accounts', 'people', 'savings_goals']);

/* ---------------------------------------------------------------------- */
/* Identity, hashing                                                      */
/* ---------------------------------------------------------------------- */

export function stableStringify(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/** Fast non-cryptographic 53-bit hash (change detection only — not security). */
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed; let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** Categories/budgets are created per device with random ids, so they sync by NAME (otherwise every device duplicates them). */
const NATURAL = { categories: (r) => `${r.kind}:${String(r.name).toLowerCase()}`, budgets: (r) => `cat:${r.category}` };
export const naturalId = (store, rec) => (store === 'settings' ? rec.key : NATURAL[store] ? NATURAL[store](rec) : rec.id);
export const metaKey = (store, nid) => `${store}|${nid}`;

/** The part of a record that is actually synced. */
export function syncedCore(store, rec) {
  const out = { ...rec };
  for (const f of DERIVED[store] || []) delete out[f];
  return out;
}
/** Content hash used for change detection (ignores derived numbers, and the device-specific id of natural-key stores). */
export function recordHash(store, rec) {
  const core = syncedCore(store, rec);
  // Name-keyed records (categories, budgets) are created separately on each device, so their random id and
  // creation time differ even when they are "the same thing". Ignoring them stops every new device from
  // reporting a dozen fake conflicts for its freshly seeded default categories.
  if (NATURAL[store]) { delete core.id; delete core.createdAt; delete core.updatedAt; }
  return cyrb53(stableStringify(core));
}

/* ---------------------------------------------------------------------- */
/* Local reads / bookkeeping                                              */
/* ---------------------------------------------------------------------- */

async function readLocal() {
  const out = new Map();
  await withTransaction(SYNC_STORES, 'readonly', async (tx) => {
    for (const store of SYNC_STORES) {
      const rows = await reqToPromise(tx.objectStore(store).getAll());
      for (const rec of rows) {
        if (store === 'settings' && SETTINGS_EXCLUDE.has(rec.key)) continue;
        const nid = naturalId(store, rec);
        out.set(metaKey(store, nid), { store, nid, rec, hash: recordHash(store, rec) });
      }
    }
  });
  return out;
}

async function readMeta() {
  const rows = await withTransaction([META], 'readonly', (tx) => reqToPromise(tx.objectStore(META).getAll()));
  return new Map(rows.filter((r) => !r.key.startsWith('__')).map((r) => [r.key, r]));
}

const getSpecial = async (key) => (await withTransaction([META], 'readonly', (tx) => reqToPromise(tx.objectStore(META).get(key))))?.value;
const putSpecial = (key, value) => withTransaction([META], 'readwrite', (tx) => { tx.objectStore(META).put({ key, value }); }, { quiet: true });

export async function getSyncCursor(datasetId) {
  const c = await getSpecial(CURSOR);
  return c && c.datasetId === datasetId ? c.seq : 0;
}
export const getConflictLog = async () => (await getSpecial(CONFLICTS)) || [];
export async function clearConflictLog() { await putSpecial(CONFLICTS, []); }

async function appendConflicts(items) {
  if (!items.length) return;
  const log = [...items, ...(await getConflictLog())].slice(0, MAX_CONFLICT_LOG);
  await putSpecial(CONFLICTS, log);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('finora:sync-conflicts', { detail: { count: items.length } }));
  }
}

/** Forget all bookkeeping for a dataset switch / reset (the next sync behaves like a first sync). */
export async function resetSyncState() {
  await withTransaction([META], 'readwrite', (tx) => { tx.objectStore(META).clear(); }, { quiet: true });
}

/* ---------------------------------------------------------------------- */
/* Legacy ledger ids  ->  ids that are unique across devices              */
/* ---------------------------------------------------------------------- */

const LEGACY_ID = /^TXN-\d{4}-\d{6}$/;
const ID_FIELDS = ['createdAt', 'type', 'direction', 'amount', 'date', 'accountId', 'toAccountId', 'personId', 'description'];

/**
 * Old ledger ids (TXN-2026-000001) restart at 1 on every device, so two devices' DIFFERENT transactions can share
 * an id — fatal when they meet on a server. Give each a deterministic suffix derived from the transaction's own
 * content: two devices holding the SAME transaction (e.g. via a restored backup) compute the SAME new id (no
 * duplicate), while two DIFFERENT transactions get different ids. All references are rewritten. Runs once.
 */
export async function migrateLegacyLedgerIds() {
  if (await getSpecial(MIGRATED)) return 0;
  let migrated = 0;
  await whileApplying(() => withTransaction(SYNC_STORES, 'readwrite', async (tx) => {
    const ledger = await reqToPromise(tx.objectStore('ledger').getAll());
    const legacy = ledger.filter((r) => LEGACY_ID.test(r.id));
    if (legacy.length === 0) return;
    const idMap = new Map(legacy.map((r) => [r.id, `${r.id}-${cyrb53(stableStringify(Object.fromEntries(ID_FIELDS.map((k) => [k, r[k] ?? null])))).slice(0, 6)}`]));
    const patterns = [...idMap.keys()].map((old) => [old, new RegExp(`${old}(?![\\w-])`, 'g')]);

    for (const name of SYNC_STORES) {
      const store = tx.objectStore(name);
      const rows = await reqToPromise(store.getAll());
      for (const rec of rows) {
        const fixed = remapIds(rec, idMap, patterns);
        if (name === 'ledger' && idMap.has(rec.id)) {          // the legacy row itself: new primary key
          store.delete(rec.id);
          store.put({ ...fixed, id: idMap.get(rec.id) });
        } else if (stableStringify(fixed) !== stableStringify(rec)) {
          store.put(fixed);                                    // anything that merely POINTS at a legacy id
        }
      }
    }
    migrated = legacy.length;
  }));
  await putSpecial(MIGRATED, true);
  return migrated;
}

/* ---------------------------------------------------------------------- */
/* PULL                                                                   */
/* ---------------------------------------------------------------------- */

const fail = (error, what) => { throw new SyncError(`${what}: ${error.message || error}`, error); };
export class SyncError extends Error {
  constructor(message, cause) { super(message); this.name = 'SyncError'; this.cause = cause; this.status = cause?.status || 0; }
}

async function findLocal(tx, store, nat, row) {
  if (NATURAL[store]) return nat[store].get(row.record_id) || null;
  return (await reqToPromise(tx.objectStore(store).get(row.record_id))) || null;
}

/** Applies one decrypted page inside ONE transaction (records + bookkeeping together). */
async function applyPage(rows, metaMap) {
  const conflicts = []; let recompute = false; let applied = 0;
  await withTransaction([...SYNC_STORES, META], 'readwrite', async (tx) => {
    const nat = {};
    for (const s of Object.keys(NATURAL)) nat[s] = new Map((await reqToPromise(tx.objectStore(s).getAll())).map((r) => [naturalId(s, r), r]));
    const metaStore = tx.objectStore(META);

    for (const row of rows) {
      if (!SYNC_STORES.includes(row.store)) continue;                  // a store from a newer app version: ignore, don't crash
      const key = metaKey(row.store, row.record_id);
      const meta = metaMap.get(key);
      if (meta && row.rev <= meta.rev) continue;                       // already have this (or newer)

      const store = tx.objectStore(row.store);
      const local = await findLocal(tx, row.store, nat, row);
      const localHash = local ? recordHash(row.store, local) : null;
      const remoteHash = row.deleted ? null : recordHash(row.store, row.value);
      // Does THIS device hold a change the server has not seen? (then taking the server's version overwrites it)
      let unsynced;
      if (meta && !meta.deleted) unsynced = local ? localHash !== meta.hash : true;   // local missing = a pending local delete
      else unsynced = !!local;                                                         // never synced / known-deleted: any local copy is new
      if (row.deleted && !local) unsynced = false;                                     // both sides deleted it: nothing to lose
      const identical = !!local && !row.deleted && localHash === remoteHash;           // same content: adopt silently
      if (unsynced && !identical) {
        conflicts.push({
          store: row.store, id: row.record_id, at: new Date().toISOString(),
          kind: row.deleted ? 'remote-deleted' : (local ? 'remote-edited' : 'local-deleted'),
          local: local ? syncedCore(row.store, local) : null,                          // YOUR copy is kept here, not lost
        });
      }

      if (row.deleted) {
        if (local) store.delete(row.store === 'settings' ? local.key : local.id);
        metaStore.put({ key, store: row.store, nid: row.record_id, rev: row.rev, hash: null, deleted: true });
      } else {
        let rec = { ...row.value };
        if (NATURAL[row.store] && local) rec.id = local.id;            // keep THIS device's id for name-keyed records
        for (const f of DERIVED[row.store] || []) rec[f] = local?.[f] ?? (f === 'usedAmount' ? (rec.type === 'credit_card' ? 0 : undefined) : 0);
        store.put(rec);
        metaStore.put({ key, store: row.store, nid: row.record_id, rev: row.rev, hash: recordHash(row.store, rec), deleted: false });
      }
      applied += 1;
      if (RECOMPUTE_AFTER.has(row.store)) recompute = true;
    }
    if (recompute) await recomputeBalancesInTx(tx);                    // balances are derived: rebuild from the ledger
  });
  return { conflicts, applied };
}

/** Pulls and applies everything after the cursor. Returns { applied, conflicts }. */
export async function pullChanges(ctx) {
  const { client, key, datasetId } = ctx;
  const cursor = await getSyncCursor(datasetId);
  let from = Math.max(0, cursor - PULL_OVERLAP);
  let maxSeq = cursor; let applied = 0; const allConflicts = [];

  for (;;) {
    const { data, error } = await client.from('sync_records')
      .select('store,record_id,rev,seq,deleted,payload,device_id')
      .eq('dataset_id', datasetId).gt('seq', from).order('seq', { ascending: true }).limit(PULL_PAGE);
    if (error) fail(error, 'Could not read from the server');
    if (!data.length) break;

    const metaMap = await readMeta();                                  // fresh each page: the previous page updated it
    const rows = [];
    for (const r of data) {
      const row = { ...r, rev: Number(r.rev), seq: Number(r.seq) };
      const meta = metaMap.get(metaKey(r.store, r.record_id));
      if (!(meta && row.rev <= meta.rev) && !row.deleted) row.value = await decryptValue(key, r.payload, recordAad(datasetId, r.store, r.record_id));
      rows.push(row);
    }
    // The overlap window re-reads rows we already have. Opening a (write) transaction just to skip them would
    // look like a data change to the rest of the app and re-trigger sync forever — so only apply what is new.
    const fresh = rows.filter((row) => { const m = metaMap.get(metaKey(row.store, row.record_id)); return !(m && row.rev <= m.rev); });
    if (fresh.length) {
      const res = await whileApplying(() => applyPage(fresh, metaMap));
      applied += res.applied; allConflicts.push(...res.conflicts);
    }
    maxSeq = Math.max(maxSeq, ...data.map((r) => Number(r.seq)));
    from = Number(data[data.length - 1].seq);
    if (data.length < PULL_PAGE) break;
  }
  await putSpecial(CURSOR, { datasetId, seq: maxSeq });
  await appendConflicts(allConflicts);
  return { applied, conflicts: allConflicts.length };
}

/* ---------------------------------------------------------------------- */
/* PUSH                                                                   */
/* ---------------------------------------------------------------------- */

/** Sends every locally changed / created / deleted record. Returns { pushed, conflicts }. */
export async function pushChanges(ctx) {
  const { client, key, datasetId, deviceId } = ctx;
  const [local, meta] = await Promise.all([readLocal(), readMeta()]);
  const pending = [];

  for (const [k, l] of local) {
    const m = meta.get(k);
    if (m && !m.deleted && m.hash === l.hash) continue;                // unchanged since last sync
    pending.push({ store: l.store, nid: l.nid, key: k, hash: l.hash, deleted: false, base: m ? m.rev : 0, value: syncedCore(l.store, l.rec) });
  }
  for (const [k, m] of meta) {
    if (m.deleted || local.has(k)) continue;                           // known-deleted, or still here
    pending.push({ store: m.store, nid: m.nid, key: k, hash: null, deleted: true, base: m.rev, value: {} });   // deleted locally -> tombstone
  }

  let pushed = 0; let conflicts = 0;
  for (let i = 0; i < pending.length; i += PUSH_BATCH) {
    const batch = pending.slice(i, i + PUSH_BATCH);
    const items = [];
    for (const p of batch) {
      items.push({ store: p.store, record_id: p.nid, base_rev: p.base, deleted: p.deleted, payload: await encryptValue(key, p.value, recordAad(datasetId, p.store, p.nid)) });
    }
    const { data, error } = await client.rpc('sync_push', { p_dataset: datasetId, p_device: deviceId, p_items: items });
    if (error) fail(error, 'Could not send to the server');

    const byKey = new Map(batch.map((p) => [p.key, p]));
    await withTransaction([META], 'readwrite', (tx) => {
      const metaStore = tx.objectStore(META);
      for (const r of data) {
        const p = byKey.get(metaKey(r.store, r.record_id));
        if (!p) continue;
        if (r.status === 'ok') { metaStore.put({ key: p.key, store: p.store, nid: p.nid, rev: Number(r.rev), hash: p.hash, deleted: p.deleted }); pushed += 1; }
        else conflicts += 1;
      }
    }, { quiet: true });
  }
  return { pushed, conflicts };
}

/* ---------------------------------------------------------------------- */
/* One full pass                                                          */
/* ---------------------------------------------------------------------- */

/**
 * pull -> push (-> pull -> push again once if the push hit conflicts).
 * ctx = { client, key (CryptoKey), datasetId, deviceId }
 * Returns { pulled, pushed, conflicts, migrated }.
 */
export async function syncOnce(ctx) {
  const migrated = await migrateLegacyLedgerIds();
  let pull = await pullChanges(ctx);
  let push = await pushChanges(ctx);
  let conflicts = pull.conflicts;
  if (push.conflicts > 0) {                                            // somebody changed it while we were pushing: take theirs, log ours
    const again = await pullChanges(ctx);
    conflicts += again.conflicts; pull = { applied: pull.applied + again.applied };
    const second = await pushChanges(ctx);
    push = { pushed: push.pushed + second.pushed, conflicts: second.conflicts };
  }
  return { pulled: pull.applied, pushed: push.pushed, conflicts, unresolved: push.conflicts, migrated };
}

export { E2EError };
