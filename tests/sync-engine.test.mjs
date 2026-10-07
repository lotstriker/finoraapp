// The sync engine against the REAL schema.sql (Postgres via PGlite) with two simulated devices (two local databases).
import './setup.mjs';
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, clientFor } from './pg-supabase.mjs';

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';

const { openDB, closeDB, getAll, getById, withTransaction } = await import('../js/core/db.js');
const { getProfiles, createProfile, switchProfile } = await import('../js/modules/profiles.js');
const { seedDefaultCategories, getCategories } = await import('../js/modules/categories.js');
const { createAccount } = await import('../js/modules/accounts.js');
const { createExpense } = await import('../js/modules/expenses.js');
const { createIncome } = await import('../js/modules/income.js');
const People = await import('../js/modules/people.js');
const B = await import('../js/modules/backup.js');
const E = await import('../js/modules/sync-engine.js');
const C = await import('../js/modules/e2e-crypto.js');
const L = await import('../js/core/ledger.js');
const { setSetting, getSetting } = await import('../js/modules/preferences.js');

let server; let key; let used = 0; const DS = 'ds_testdataset';
const POOL = ['dev-1', 'dev-2', 'dev-3', 'dev-4'];      // reused profiles (the app caps profiles at 6), wiped by fresh()

before(async () => { key = (await C.createEncryption('mango river cricket lamp')).key; });
beforeEach(async () => { server = await createServer([U1, U2]); used = 0; });

/** A simulated device = its own profile = its own IndexedDB; one shared account on the server. */
function device(label, { user = U1, enc = () => key, dataset = DS } = {}) {
  const name = POOL[used++];
  const d = {
    name,
    async use() { await closeDB(); const p = getProfiles().find((x) => x.name === name) || createProfile({ name }); switchProfile(p.id); await openDB(); return d; },
    async fresh() { await d.use(); await B.deleteAllData(); await seedDefaultCategories(); return d; },     // like a brand-new device
    ctx: async () => ({ client: clientFor(server, user, name), key: enc(), datasetId: dataset, deviceId: await B.getDeviceId() }),
    async sync() { await d.use(); return E.syncOnce(await d.ctx()); },
    async pull() { await d.use(); return E.pullChanges(await d.ctx()); },
  };
  return d;
}
const serverRows = async (extra = '') => (await server.db.query(`select store, record_id, rev, deleted, payload from public.sync_records ${extra} order by seq`)).rows;
const accountByName = async (name) => (await getAll('accounts')).find((a) => a.name === name);

test('first sync pushes everything; the server holds ONLY ciphertext; a second sync pushes nothing', async () => {
  const pc = await device('pc').fresh();
  const a = await createAccount({ name: 'Salary Bank', type: 'bank', initialBalance: 12345 });
  await createExpense({ accountId: a.id, amount: 250, category: 'Groceries', description: 'Secret milk purchase' });
  const r1 = await pc.sync();
  assert.ok(r1.pushed > 5);
  const rows = await serverRows();
  const blob = JSON.stringify(rows);
  for (const secret of ['Salary Bank', 'Secret milk', '12345', 'Groceries', '250']) assert.ok(!blob.includes(secret), `"${secret}" leaked in plaintext`);
  assert.ok(rows.some((r) => r.store === 'ledger') && rows.some((r) => r.store === 'accounts'));
  const r2 = await pc.sync();
  assert.equal(r2.pushed, 0); assert.equal(r2.pulled, 0);
});

test('a second device receives the data, and balances match (derived numbers are RECOMPUTED, not copied)', async () => {
  const pc = await device('pc').fresh();
  const a = await createAccount({ name: 'Main', type: 'bank', initialBalance: 10000 });
  await createExpense({ accountId: a.id, amount: 1500, category: 'Groceries' });
  await createIncome({ accountId: a.id, amount: 400, category: 'Salary' });
  await pc.sync();

  const phone = await device('phone').fresh();
  const r = await phone.sync();
  assert.ok(r.pulled > 0);
  const onPhone = await accountByName('Main');
  assert.equal(onPhone.balance, 8900);
  assert.equal((await getAll('ledger')).length, 3);
  // balances are not part of the synced payload
  const acctRow = (await serverRows(`where store='accounts'`))[0];
  const plain = await C.decryptValue(key, acctRow.payload, C.recordAad(DS, 'accounts', acctRow.record_id));
  assert.equal('balance' in plain, false);
});

test('edits flow both ways without double counting: phone adds an expense, PC sees it, totals agree', async () => {
  const pc = await device('pc').fresh();
  const a = await createAccount({ name: 'Main', type: 'bank', initialBalance: 5000 });
  await pc.sync();
  const phone = await device('phone').fresh(); await phone.sync();
  const pa = await accountByName('Main');
  await createExpense({ accountId: pa.id, amount: 300, category: 'Groceries' });
  await phone.sync();
  await pc.sync();
  assert.equal((await accountByName('Main')).balance, 4700);
  await createExpense({ accountId: (await accountByName('Main')).id, amount: 200, category: 'Groceries' });
  await pc.sync(); await phone.sync();
  assert.equal((await accountByName('Main')).balance, 4500);
  const ledger = await getAll('ledger');
  assert.equal(ledger.length, new Set(ledger.map((t) => t.id)).size, 'no duplicate ids');
  assert.equal(ledger.length, 3);
});

test('SAME record edited on both devices -> the newer server version wins and YOUR copy is kept in the conflict log', async () => {
  const pc = await device('pc').fresh();
  await createAccount({ name: 'Wallet', type: 'cash', initialBalance: 100 });
  await pc.sync();
  const phone = await device('phone').fresh(); await phone.sync();

  await pc.use(); let a = await accountByName('Wallet');
  await withTransaction(['accounts'], 'readwrite', (tx) => { tx.objectStore('accounts').put({ ...a, name: 'Wallet (PC)' }); });
  await pc.sync();                                                       // PC's rename reaches the server first

  await phone.use(); a = await accountByName('Wallet');
  await withTransaction(['accounts'], 'readwrite', (tx) => { tx.objectStore('accounts').put({ ...a, name: 'Wallet (phone)' }); });
  const r = await phone.sync();                                          // phone had an unsynced edit of the same record
  assert.equal(r.conflicts, 1);
  assert.ok(await accountByName('Wallet (PC)'), 'server version applied on the phone');
  const log = await E.getConflictLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].local.name, 'Wallet (phone)', 'the overwritten edit is preserved, not lost');
  assert.equal(log[0].kind, 'remote-edited');
});

test('deletes propagate as tombstones; a delete vs a concurrent edit is reported', async () => {
  const pc = await device('pc').fresh();
  const raj = await People.createPerson({ name: 'Raj' });
  const sam = await People.createPerson({ name: 'Sam' });
  await pc.sync();
  const phone = await device('phone').fresh(); await phone.sync();
  assert.equal((await getAll('people')).length, 2);

  await pc.use();
  await withTransaction(['people'], 'readwrite', (tx) => { tx.objectStore('people').delete(raj.id); });
  await pc.sync();
  assert.equal((await serverRows(`where record_id='${raj.id}'`))[0].deleted, true, 'a tombstone, not a hard delete');
  await phone.sync();
  assert.deepEqual((await getAll('people')).map((p) => p.name), ['Sam']);

  // phone edits Sam while PC deletes Sam -> delete wins, phone's edit is logged
  await phone.use();
  const s = (await getAll('people'))[0];
  await withTransaction(['people'], 'readwrite', (tx) => { tx.objectStore('people').put({ ...s, name: 'Sam (edited)' }); });
  await pc.use(); await withTransaction(['people'], 'readwrite', (tx) => { tx.objectStore('people').delete(sam.id); }); await pc.sync();
  const r = await phone.sync();
  assert.equal((await getAll('people')).length, 0);
  assert.equal(r.conflicts, 1);
  assert.equal((await E.getConflictLog())[0].kind, 'remote-deleted');
});

test('default categories are NOT duplicated across devices (they sync by name); an archive change syncs', async () => {
  const pc = await device('pc').fresh();
  const before = (await getCategories('expense')).length;
  await pc.sync();
  const phone = await device('phone').fresh();
  await phone.sync();
  assert.equal((await getCategories('expense')).length, before, 'phone kept ONE copy of each default category');
  await pc.use();
  const g = (await getAll('categories')).find((c) => c.name === 'Groceries');
  await withTransaction(['categories'], 'readwrite', (tx) => { tx.objectStore('categories').put({ ...g, archived: true }); });
  await pc.sync(); await phone.sync();
  assert.equal((await getAll('categories')).find((c) => c.name === 'Groceries').archived, true);
  assert.equal((await getAll('categories')).filter((c) => c.name === 'Groceries').length, 1);
});

test('settings sync (enabled modules), but device-local keys and the E2E key never do', async () => {
  const pc = await device('pc').fresh();
  await setSetting('enabledModules', { budgets: true, loans: true });
  await setSetting('e2eKey', { key, userId: U1 });
  await B.setCloudSync({ x: 1 });
  await pc.sync();
  const stores = (await serverRows()).filter((r) => r.store === 'settings').map((r) => r.record_id);
  assert.ok(stores.includes('enabledModules'));
  for (const k of ['e2eKey', 'cloudSync', 'deviceId', 'ledgerCounter', 'datasetId']) assert.ok(!stores.includes(k), `${k} must not sync`);
  const phone = await device('phone').fresh(); await phone.sync();
  assert.deepEqual(await getSetting('enabledModules'), { budgets: true, loans: true });
  assert.equal(await getSetting('e2eKey', null), null, 'the phone did not receive the PC\'s key');
});

/* ---------------- legacy ledger ids ---------------- */
const legacyRow = (id, over = {}) => ({ id, type: 'expense', direction: 'out', amount: 10, status: 'completed', tags: [], date: '2026-03-01T12:00:00.000Z', createdAt: '2026-03-01T12:00:00.000Z', description: 'x', ...over });

test('two devices with DIFFERENT transactions that share a legacy id (TXN-…-000001) keep BOTH, with references intact', async () => {
  const pc = await device('pc').fresh(); const acc1 = await createAccount({ name: 'PC acct', type: 'bank', initialBalance: 1000 });
  await withTransaction(['ledger'], 'readwrite', (tx) => {
    tx.objectStore('ledger').put(legacyRow('TXN-2026-000001', { accountId: acc1.id, amount: 111, description: 'PC lunch' }));
    tx.objectStore('ledger').put(legacyRow('TXN-2026-000002', { accountId: acc1.id, direction: 'in', amount: 111, description: 'Reversal of TXN-2026-000001', parentTransactionId: 'TXN-2026-000001', type: 'expense' }));
  });
  const phone = await device('phone').fresh(); const acc2 = await createAccount({ name: 'Phone acct', type: 'bank', initialBalance: 500 });
  await withTransaction(['ledger'], 'readwrite', (tx) => { tx.objectStore('ledger').put(legacyRow('TXN-2026-000001', { accountId: acc2.id, amount: 222, description: 'Phone tea' })); });
  await pc.sync(); await phone.sync(); await pc.sync();

  for (const d of [pc, phone]) {
    await d.use();
    const ledger = await getAll('ledger');
    assert.ok(ledger.some((t) => t.description === 'PC lunch') && ledger.some((t) => t.description === 'Phone tea'), `${d.name} lost a transaction`);
    assert.ok(ledger.every((t) => !/^TXN-\d{4}-\d{6}$/.test(t.id)), 'no bare legacy ids remain');
    const lunch = ledger.find((t) => t.description === 'PC lunch'); const rev = ledger.find((t) => t.parentTransactionId);
    assert.equal(rev.parentTransactionId, lunch.id, 'reference followed the new id');
    assert.ok(rev.description.includes(lunch.id));
  }
});

test('the SAME legacy transaction on two devices (shared origin) is NOT duplicated', async () => {
  const pc = await device('pc').fresh(); const acc = await createAccount({ name: 'Shared', type: 'bank', initialBalance: 1000 });
  const row = legacyRow('TXN-2026-000007', { accountId: acc.id, amount: 77, description: 'same on both' });
  await withTransaction(['ledger'], 'readwrite', (tx) => { tx.objectStore('ledger').put(row); });
  // phone = a copy of the PC's data (like restoring the same backup), then both sync
  const snap = { stores: await B.exportAllStores() };
  const phone = await device('phone').fresh(); await B.restoreBackup(snap, 'replace');
  await pc.sync(); await phone.sync(); await pc.sync();
  for (const d of [pc, phone]) { await d.use(); assert.equal((await getAll('ledger')).filter((t) => t.description === 'same on both').length, 1, `${d.name}`); }
});

/* ---------------- safety ---------------- */
test('"Delete all data" / Replace-restore on one device must NOT delete the other devices\' data', async () => {
  const pc = await device('pc').fresh(); const a = await createAccount({ name: 'Keep me', type: 'bank', initialBalance: 100 });
  await createExpense({ accountId: a.id, amount: 5, category: 'Groceries' });
  await pc.sync();
  const phone = await device('phone').fresh(); await phone.sync();
  const live = (await serverRows()).filter((r) => !r.deleted).length;

  await phone.use(); await B.deleteAllData();                            // wipes the phone only
  await phone.sync();
  assert.equal((await serverRows()).filter((r) => !r.deleted).length, live, 'no tombstones were pushed');
  assert.equal((await getAll('accounts')).length, 1, 'the phone got its data back from the server');

  await B.restoreBackup({ stores: { accounts: [], ledger: [] } }, 'replace');   // restore an almost-empty backup
  await phone.sync();
  assert.equal((await serverRows()).filter((r) => !r.deleted).length, live);
  await pc.sync();
  assert.equal((await getAll('accounts')).length, 1, 'the PC still has everything');
});

test('wrong key / tampering: decryption failures stop the sync instead of corrupting data', async () => {
  const pc = await device('pc').fresh(); await createAccount({ name: 'A', type: 'bank', initialBalance: 1 }); await pc.sync();
  const otherKey = (await C.createEncryption('a completely different passphrase')).key;
  const intruder = device('phone', { enc: () => otherKey }); await intruder.fresh();
  await assert.rejects(() => intruder.sync(), (e) => e.name === 'E2EError');
  assert.equal((await getAll('accounts')).length, 0, 'nothing was written');

  // a malicious server swaps two records' ciphertexts
  const rows = (await server.db.query(`select store, record_id, payload from public.sync_records where store in ('accounts','ledger') order by seq limit 2`)).rows;
  await server.db.exec(`update public.sync_records set payload = '${rows[1].payload}' where record_id = '${rows[0].record_id}' and store = '${rows[0].store}'`);
  const phone = await device('phone2').fresh();
  await assert.rejects(() => phone.sync(), (e) => e.name === 'E2EError');
});

test('another Google user can neither read nor disturb this data (RLS), even with the same dataset id', async () => {
  const pc = await device('pc').fresh(); await createAccount({ name: 'Mine', type: 'bank', initialBalance: 1 }); await pc.sync();
  const stranger = device('stranger', { user: U2 }); await stranger.fresh();
  const r = await stranger.sync();
  assert.equal(r.pulled, 0);
  assert.equal((await getAll('accounts')).length, 0);
  await createAccount({ name: 'Theirs', type: 'bank', initialBalance: 9 }); await stranger.sync();
  await pc.sync();
  assert.deepEqual((await getAll('accounts')).map((a) => a.name), ['Mine']);
});

test('large data: >500 rows paginate on pull and >200 rows batch on push; the cursor re-read is idempotent', async () => {
  const pc = await device('pc').fresh(); const a = await createAccount({ name: 'Big', type: 'bank', initialBalance: 1 });
  await withTransaction(['ledger'], 'readwrite', (tx) => {
    for (let i = 0; i < 1100; i++) tx.objectStore('ledger').put(legacyRow(`TXN-2026-${String(i + 100).padStart(6, '0')}-k3x9`, { accountId: a.id, amount: 1, description: `row ${i}` }));
  });
  const r = await pc.sync();
  assert.ok(r.pushed >= 1100);
  const rpcsForPush = server.stats.rpc;
  assert.ok(rpcsForPush >= 6, `pushed in batches (${rpcsForPush} calls)`);
  const phone = await device('phone').fresh();
  const p = await phone.sync();
  assert.ok(p.pulled >= 1100);
  assert.equal((await getAll('ledger')).length, 1101);                    // 1100 + the opening-balance row
  const again = await phone.pull();                                       // overlap re-reads a few rows: nothing re-applied
  assert.equal(again.applied, 0);
});

test('interrupted push: a failure half-way leaves a consistent state, and the next sync finishes it without duplicates', async () => {
  const pc = await device('pc').fresh(); const a = await createAccount({ name: 'Flaky', type: 'bank', initialBalance: 1 });
  await withTransaction(['ledger'], 'readwrite', (tx) => { for (let i = 0; i < 450; i++) tx.objectStore('ledger').put(legacyRow(`TXN-2026-${String(i + 100).padStart(6, '0')}-k3x9`, { accountId: a.id, description: `r${i}` })); });
  let calls = 0; const real = server.client; await pc.use();
  const ctx = await pc.ctx(); const origRpc = ctx.client.rpc;
  ctx.client.rpc = async (...args) => { if (++calls === 2) return { data: null, error: { message: 'connection reset' } }; return origRpc(...args); };
  await assert.rejects(() => E.syncOnce(ctx), /Could not send/);
  const partial = (await serverRows()).length;
  assert.ok(partial > 0 && partial < 460, `partial upload (${partial})`);
  await pc.sync();
  assert.equal((await serverRows()).length, (await getAll('ledger')).length + (await getAll('accounts')).length + (await getAll('categories')).length + (await getAll('settings')).filter((s) => !['deviceId','ledgerCounter','datasetId'].includes(s.key)).length);
  const phone = await device('phone').fresh(); await phone.sync();
  assert.equal((await getAll('ledger')).length, 451);
});

test('a store this app version does not know (from a newer version) is ignored, not fatal', async () => {
  const pc = await device('pc').fresh(); await createAccount({ name: 'A', type: 'bank', initialBalance: 1 }); await pc.sync();
  const payload = await C.encryptValue(key, { id: 'z1' }, C.recordAad(DS, 'future_store', 'z1'));
  await server.db.exec(`insert into public.sync_records (user_id, dataset_id, store, record_id, payload, device_id) values ('${U1}', '${DS}', 'future_store', 'z1', '${payload}', 'new')`);
  const phone = await device('phone').fresh();
  const r = await phone.sync();
  assert.ok(r.pulled > 0);
});

test('REGRESSION: re-reading already-known rows (the cursor overlap) does not look like a data change — no sync loop', async () => {
  const pc = await device('pc').fresh(); await createAccount({ name: 'Loop?', type: 'bank', initialBalance: 1 });
  await pc.sync(); await pc.sync();
  const { onDataChanged } = await import('../js/core/db.js');
  let writes = 0; const off = onDataChanged(() => { writes++; });
  const r = await pc.pull(); await pc.pull();
  off();
  assert.equal(r.applied, 0);
  assert.equal(writes, 0, 'a pull that finds nothing new must not write (and so cannot re-trigger sync)');
});

test('remote data landing is flagged, so the scheduler can tell it from a user edit', async () => {
  const pc = await device('pc').fresh(); await createAccount({ name: 'X', type: 'bank', initialBalance: 1 }); await pc.sync();
  const phone = await device('phone').fresh();
  const { onDataChanged } = await import('../js/core/db.js');
  const flags = []; const off = onDataChanged(() => flags.push(E.isApplyingRemote()));
  await phone.sync(); off();
  assert.ok(flags.length > 0 && flags.every(Boolean), 'every write during the pull was marked as remote');
});
