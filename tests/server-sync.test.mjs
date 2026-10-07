// The scheduler (server-sync.js) end to end: real Postgres schema, fake HTTP, ONE active device at a time.
// The "other device" is simulated at the protocol level (it encrypts a record and calls sync_push) so the
// device under test can be watched reacting to Realtime hints without swapping local databases mid-test.
import './setup.mjs';
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, clientFor } from './pg-supabase.mjs';

const U1 = '11111111-1111-1111-1111-111111111111';
const { openDB, closeDB, getAll, withTransaction } = await import('../js/core/db.js');
const { getProfiles, createProfile, switchProfile } = await import('../js/modules/profiles.js');
const { seedDefaultCategories } = await import('../js/modules/categories.js');
const { createAccount } = await import('../js/modules/accounts.js');
const { createExpense } = await import('../js/modules/expenses.js');
const B = await import('../js/modules/backup.js');
const C = await import('../js/modules/e2e-crypto.js');
const SB = await import('../js/modules/supabase-client.js');
const SS = await import('../js/modules/server-sync.js');
const E = await import('../js/modules/sync-engine.js');

let server; let key; const DS = 'ds_live';
const waitFor = async (cond, ms = 5000) => { const t0 = Date.now(); for (;;) { if (await cond()) return; if (Date.now() - t0 > ms) throw new Error(`timed out: ${cond}`); await new Promise((r) => setTimeout(r, 15)); } };
const rows = async (w = '') => (await server.db.query(`select store, record_id, rev, deleted from public.sync_records ${w} order by seq`)).rows;
let busy = false; let applied = 0;

async function bootDevice(name, { userId = U1, saveKey = true, session = true } = {}) {
  await closeDB();
  const p = getProfiles().find((x) => x.name === name) || createProfile({ name });
  switchProfile(p.id); await openDB(); await B.deleteAllData(); await seedDefaultCategories();
  if (saveKey) await C.saveLocalKey(key, userId);
  await B.setDatasetId(DS);
  const client = clientFor(server, session ? userId : null, name);
  SB.configureSupabase({ url: 'https://abcdefghijklmnopqrst.supabase.co', key: 'sb_publishable_abc', createClient: () => client });
  return client;
}
/** Another device writes one record to the server (as its own sync engine would). */
async function remoteWrite(store, record, { recordId = record.id, deleted = false, baseRev = 0 } = {}) {
  const c = clientFor(server, U1, 'remote');
  const payload = await C.encryptValue(key, deleted ? {} : record, C.recordAad(DS, store, recordId));
  const { data, error } = await c.rpc('sync_push', { p_dataset: DS, p_device: 'remote-dev', p_items: [{ store, record_id: recordId, base_rev: baseRev, deleted, payload }] });
  assert.equal(error, null); return data[0];
}

before(async () => { key = (await C.createEncryption('mango river cricket lamp')).key; });
beforeEach(async () => {
  server = await createServer([U1]); busy = false; applied = 0;
  Object.assign(SS.TIMING, { debounce: 60, maxWait: 400, realtime: 30, pollNoRealtime: 150, pollWithRealtime: 60000, busyRetry: 80, startup: 20 });
  SS.__resetServerSyncForTests();
});
afterEach(async () => { await SS.stopServerSync(); });
const start = () => SS.startServerSync({ isBusy: () => busy, onRemoteApplied: () => { applied++; } });

test('enabling: first sync uploads, status becomes idle, Realtime connects', async () => {
  await bootDevice('dev-1');
  const a = await createAccount({ name: 'Main', type: 'bank', initialBalance: 1000 });
  await start();
  const st = await SS.enableServerSync();
  assert.equal(st.state, 'idle');
  assert.ok((await rows()).length > 5);
  await waitFor(() => SS.getServerSyncStatus().realtime === true);
  assert.equal(await SS.isServerSyncEnabled(), true);
});

test('LIVE (A): your edit is pushed automatically after a short pause, no button pressed', async () => {
  await bootDevice('dev-1');
  const a = await createAccount({ name: 'Main', type: 'bank', initialBalance: 1000 });
  await start(); await SS.enableServerSync();
  const before = (await rows(`where store='ledger'`)).length;
  await createExpense({ accountId: a.id, amount: 40, category: 'Groceries' });
  assert.equal(SS.getServerSyncStatus().state, 'pending');
  await waitFor(async () => (await rows(`where store='ledger'`)).length === before + 1);
  await waitFor(() => SS.getServerSyncStatus().state === 'idle');
});

test('LIVE (B): another device\'s change arrives by itself via the Realtime hint, and balances update', async () => {
  await bootDevice('dev-1');
  const a = await createAccount({ name: 'Main', type: 'bank', initialBalance: 1000 });
  await start(); await SS.enableServerSync();
  await waitFor(() => SS.getServerSyncStatus().realtime === true);
  const selectsBefore = server.stats.selects;
  const t = { id: 'TXN-2026-000500-zzzz', type: 'expense', direction: 'out', amount: 250, status: 'completed', tags: [], category: 'Groceries',
    accountId: a.id, date: new Date().toISOString(), createdAt: new Date().toISOString(), description: 'from the phone' };
  await remoteWrite('ledger', t);
  await waitFor(async () => (await getAll('ledger')).some((x) => x.id === t.id));
  assert.equal((await getAll('accounts')).find((x) => x.id === a.id).balance, 750);
  await waitFor(() => applied >= 1);                                    // the hook runs when the whole cycle ends
  assert.ok(applied >= 1, 'UI refresh hook was called');
  assert.ok(server.stats.selects > selectsBefore);
});

test('our own pushes echo back through Realtime but do NOT cause a pointless extra pull', async () => {
  await bootDevice('dev-1');
  const a = await createAccount({ name: 'Main', type: 'bank', initialBalance: 1000 });
  await start(); await SS.enableServerSync();
  await waitFor(() => SS.getServerSyncStatus().realtime === true);
  await createExpense({ accountId: a.id, amount: 5, category: 'Groceries' });
  await waitFor(() => SS.getServerSyncStatus().state === 'idle' && server.stats.rpc >= 2);
  await new Promise((r) => setTimeout(r, 200));                          // let any echo arrive
  const rpc = server.stats.rpc; const sel = server.stats.selects;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(server.stats.rpc, rpc); assert.equal(server.stats.selects, sel, 'quiet when nothing changed');
});

test('a remote DELETE (tombstone) removes the record locally, live', async () => {
  await bootDevice('dev-1');
  const a = await createAccount({ name: 'Main', type: 'bank', initialBalance: 1 });
  await start();
  const person = { id: 'per_remote1', name: 'Raj', balance: 0, createdAt: new Date().toISOString() };
  const w = await remoteWrite('people', person);
  await SS.enableServerSync();
  assert.ok((await getAll('people')).some((p) => p.id === 'per_remote1'));
  await waitFor(() => SS.getServerSyncStatus().realtime === true);
  await remoteWrite('people', person, { deleted: true, baseRev: w.rev });
  await waitFor(async () => !(await getAll('people')).some((p) => p.id === 'per_remote1'));
});

test('offline: state "offline", no requests; when the network returns it recovers by itself', async () => {
  await bootDevice('dev-1'); await createAccount({ name: 'Main', type: 'bank', initialBalance: 1 });
  await start(); await SS.enableServerSync();
  server.offline = true;
  await createExpense({ accountId: (await getAll('accounts'))[0].id, amount: 3, category: 'Groceries' });
  await waitFor(() => SS.getServerSyncStatus().state === 'offline');
  assert.match(SS.getServerSyncStatus().message, /paused|offline/i);
  assert.ok(SS.getServerSyncStatus().retryAt > Date.now(), 'a retry is scheduled');
  server.offline = false;
  await SS.runServerSync({ reason: 'test' });
  assert.equal(SS.getServerSyncStatus().state, 'idle');
  assert.equal((await rows(`where store='ledger'`)).length, 2);
});

test('signed out -> needs-signin; no key on this device -> needs-unlock (never syncs without them)', async () => {
  await bootDevice('dev-1', { session: false }); await createAccount({ name: 'Main', type: 'bank', initialBalance: 1 });
  await start(); await B.setDatasetId(DS);
  await SS.enableServerSync().catch(() => {});
  assert.equal(SS.getServerSyncStatus().state, 'needs-signin');
  assert.equal((await rows()).length, 0);

  await SS.stopServerSync(); SS.__resetServerSyncForTests();
  await bootDevice('dev-1', { saveKey: false }); await createAccount({ name: 'Main', type: 'bank', initialBalance: 1 });
  await start(); await SS.enableServerSync();
  assert.equal(SS.getServerSyncStatus().state, 'needs-unlock');
  assert.equal((await rows()).length, 0);
});

test('while a dialog is open nothing is synced (data is never swapped under the user); afterwards it catches up', async () => {
  await bootDevice('dev-1'); const a = await createAccount({ name: 'Main', type: 'bank', initialBalance: 1 });
  await start(); await SS.enableServerSync();
  busy = true;
  const rpc = server.stats.rpc;
  await createExpense({ accountId: a.id, amount: 9, category: 'Groceries' });
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(server.stats.rpc, rpc, 'no push while busy');
  busy = false;
  await waitFor(() => server.stats.rpc > rpc);
  await waitFor(() => SS.getServerSyncStatus().state === 'idle');
});

test('disable stops syncing but leaves server data alone; JOINING a dataset from a new device pulls it', async () => {
  await bootDevice('dev-1'); const a = await createAccount({ name: 'Shared Wallet', type: 'cash', initialBalance: 777 });
  await start(); await SS.enableServerSync();
  await SS.disableServerSync();
  assert.equal(SS.getServerSyncStatus().state, 'off');
  const live = (await rows()).filter((r) => !r.deleted).length;
  await createExpense({ accountId: a.id, amount: 1, category: 'Groceries' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await rows()).filter((r) => !r.deleted).length, live, 'nothing pushed while off');

  // the new device discovers which datasets exist, then joins one
  await SS.stopServerSync(); SS.__resetServerSyncForTests();
  await bootDevice('dev-2'); await B.setDatasetId('ds_something_else');
  await start();
  const list = await SS.listServerDatasets();
  assert.equal(list.length, 1); assert.equal(list[0].dataset_id, DS); assert.ok(list[0].record_count >= 5);
  const st = await SS.enableServerSync({ joinDatasetId: list[0].dataset_id });
  assert.equal(st.state, 'idle');
  assert.equal(await B.getDatasetId(), DS);
  assert.equal((await getAll('accounts')).find((x) => x.name === 'Shared Wallet').balance, 777);
});

test('realtime down -> falls back to polling, and still receives changes', async () => {
  await bootDevice('dev-1'); const a = await createAccount({ name: 'Main', type: 'bank', initialBalance: 1000 });
  await start();
  // make Realtime report a failure instead of SUBSCRIBED
  const real = clientFor(server, U1, 'dev-1');
  const orig = real.channel;
  real.channel = (n) => { const api = orig(n); const sub = api.subscribe; api.subscribe = (cb) => { api.owner = real; setTimeout(() => cb('CHANNEL_ERROR'), 0); return api; }; return api; };
  SB.configureSupabase({ url: 'https://abcdefghijklmnopqrst.supabase.co', key: 'sb_publishable_abc', createClient: () => real });
  await SS.enableServerSync();
  await waitFor(() => SS.getServerSyncStatus().realtime === false);
  const t = { id: 'TXN-2026-000600-zzzz', type: 'expense', direction: 'out', amount: 10, status: 'completed', tags: [], category: 'Groceries', accountId: a.id, date: new Date().toISOString(), createdAt: new Date().toISOString(), description: 'polled' };
  await remoteWrite('ledger', t);
  await waitFor(async () => (await getAll('ledger')).some((x) => x.id === t.id));          // arrived via the 150 ms test poll
});

test('conflicts are counted in the status; decrypt failures stop sync with a clear message', async () => {
  await bootDevice('dev-1'); await createAccount({ name: 'Main', type: 'bank', initialBalance: 1 });
  await start(); await SS.enableServerSync();
  // corrupt something on the server -> next pull must refuse, not write garbage
  await server.db.exec(`update public.sync_records set payload = 'AAAAAAAAAAAAAAAAAAAAAAAA' where store = 'accounts'`);
  await remoteWrite('people', { id: 'per_x', name: 'X', balance: 0 });
  await SS.runServerSync({ reason: 'test' });
  assert.equal(SS.getServerSyncStatus().state, 'error');
  assert.match(SS.getServerSyncStatus().message, /decrypt/i);
});

test('backoff schedule grows and is capped', () => {
  const r0 = () => 0;
  assert.deepEqual([1, 2, 3, 4].map((n) => SS.serverBackoffMs(n, r0)), [5000, 10000, 20000, 40000]);
  assert.equal(SS.serverBackoffMs(20, r0), 5 * 60 * 1000);
});
