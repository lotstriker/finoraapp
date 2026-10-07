import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './setup.mjs';
import { resetDb, bank, balanceOf, getAll } from './helpers.mjs';
import { G, resetGoogle, installFakeGoogle, otherDeviceWrites } from './fake-google.mjs';

installFakeGoogle();
const A = await import('../js/modules/google-auth.js');
const B = await import('../js/modules/backup.js');
const S = await import('../js/modules/cloud-sync.js');
const { createExpense } = await import('../js/modules/expenses.js');
const { onDataChanged, withTransaction } = await import('../js/core/db.js');
const { setSetting } = await import('../js/modules/preferences.js');

let busy = false; let applied = [];
const only = () => [...G.files.values()][0];
const uploads = () => G.calls.filter((c) => /^(POST|PATCH) .*upload/.test(c)).length;
const downloads = () => G.calls.filter((c) => c.includes('alt=media')).length;
const start = () => S.initCloudSync({ isBusy: () => busy, onRemoteApplied: (i) => applied.push(i) });
const cycle = (o) => S.runSyncCycle({ reason: 'test', ...o });
const waitFor = async (cond, ms = 4000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)); } };

beforeEach(async () => {
  S.__resetCloudSyncForTests(); resetGoogle(); await resetDb(); installFakeGoogle(); A.invalidateAccessToken();
  busy = false; applied = [];
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
});
afterEach(() => S.stopCloudSync());

test('backoff: truncated exponential with jitter (Drive docs)', () => {
  const r0 = () => 0;
  assert.deepEqual([1, 2, 3, 4].map((n) => S.computeBackoffMs(n, r0)), [30000, 60000, 120000, 240000]);
  assert.equal(S.computeBackoffMs(30, r0), 30 * 60 * 1000);            // truncated at the maximum
  const j = S.computeBackoffMs(1, () => 0.999); assert.ok(j > 30000 && j < 31000);
});

/* ---------------- A. auto-backup ---------------- */
test('A: first run with local data and an empty cloud creates the backup; dirty is cleared', async () => {
  await bank('Main', 1000);
  await start();
  const st = await cycle();
  assert.equal(st.state, 'idle');
  assert.equal(G.files.size, 1);
  assert.equal(await B.getCloudSync().then((s) => !!s.version), true);
  assert.equal(await (await import('../js/modules/preferences.js')).getSetting('cloudDirty', null), null);
});

test('A: a data change is detected, marks dirty, and the next cycle uploads it', async () => {
  const a = await bank('Main', 1000); await start(); await cycle();
  const v1 = only().version;
  await createExpense({ accountId: a.id, amount: 50, category: 'Groceries' });
  assert.equal(S.getSyncStatus().state, 'pending');                      // debounce timer armed
  await cycle();
  assert.ok(Number(only().version) > Number(v1));
  assert.equal(S.getSyncStatus().state, 'idle');
});

test('A: bookkeeping writes (sync markers, lastBackupAt) do NOT count as changes — no feedback loop', async () => {
  await bank('Main', 1000); await start(); await cycle();
  const before = uploads();
  let changes = 0; const off = onDataChanged(() => { changes++; }); 
  await B.recordBackupCompleted(); await B.setCloudSync(await B.getCloudSync()); await B.getDatasetId();
  await setSetting('notifiedLog', { x: '2026-01-01' });
  off();
  assert.equal(changes, 0);
  await cycle();
  assert.equal(uploads(), before, 'nothing uploaded');
});

test('A: dirty but identical content (e.g. edit then undo) -> no upload', async () => {
  const a = await bank('Main', 1000); await start(); await cycle();
  const before = uploads();
  await B.setCloudSync(await B.getCloudSync());
  await withTransaction(['accounts'], 'readwrite', () => {});           // a write that changes nothing
  await cycle();
  assert.equal(uploads(), before);
  assert.equal(S.getSyncStatus().state, 'idle');
});

test('A: edits made WHILE uploading keep the profile dirty and are saved by the next pass', async () => {
  const a = await bank('Main', 1000); await start(); await cycle();
  const realFetch = globalThis.fetch; let injected = false;
  globalThis.fetch = async (u, o) => {
    if (!injected && /^PATCH|upload/.test(String(u)) && String(u).includes('/upload/')) { injected = true; await createExpense({ accountId: a.id, amount: 7, category: 'Groceries' }); }
    return realFetch(u, o);
  };
  await createExpense({ accountId: a.id, amount: 5, category: 'Groceries' });
  await cycle();
  globalThis.fetch = realFetch;
  assert.equal(S.getSyncStatus().state, 'pending', 'the 2nd edit is still waiting');
  await cycle();
  assert.equal(S.getSyncStatus().state, 'idle');
});

test('A: visibility hidden flushes pending changes immediately (MDN: last reliable moment)', async () => {
  const a = await bank('Main', 1000); await start(); await cycle();
  await createExpense({ accountId: a.id, amount: 9, category: 'Groceries' });
  const before = uploads();
  S.handleVisibility('hidden');
  await waitFor(() => uploads() === before + 1);
  assert.equal(uploads(), before + 1);
});

/* ---------------- B. check the cloud ---------------- */
test('B: another device saved and this device is clean -> safe fast-forward + screen-refresh hook', async () => {
  const a = await bank('Main', 1000); await start(); await cycle();
  otherDeviceWrites(only().id);                                          // cloud moved on
  const st = await cycle();
  assert.equal(st.state, 'idle');
  assert.equal(downloads(), 1, 'cloud copy was downloaded');
  assert.equal(applied.length, 1, 'onRemoteApplied called so the UI re-renders');
  assert.equal(await balanceOf(a.id), 1000);
});

test('B: cloud newer + this device has UNSAVED changes -> conflict, nothing written, nothing overwritten', async () => {
  const a = await bank('Main', 1000); await start(); await cycle();
  otherDeviceWrites(only().id);                                          // other device saved
  await createExpense({ accountId: a.id, amount: 11, category: 'Groceries' });   // and we edited locally
  const calls = G.calls.length; const bal = await balanceOf(a.id);
  const st = await cycle();
  assert.equal(st.state, 'conflict');
  assert.ok(!G.calls.slice(calls).some((c) => /^(POST|PATCH|PUT)/.test(c)), 'no upload');
  assert.equal(downloads(), 0, 'no download/restore either');
  assert.equal(await balanceOf(a.id), bal);
});

test('B: update is deferred while a dialog is open, then applied', async () => {
  const a = await bank('Main', 1000); await start(); await cycle();
  otherDeviceWrites(only().id);
  busy = true;
  let st = await cycle();
  assert.equal(st.state, 'update-available');
  assert.equal(applied.length, 0);
  busy = false;
  st = await cycle();
  assert.equal(st.state, 'idle');
  assert.equal(applied.length, 1);
});

test('B: fresh device with an EMPTY local profile and an existing backup -> asks (choose-backup), never forks silently', async () => {
  await bank('PC', 1000); await start(); await cycle();                  // PC saved
  const pcFile = only();
  S.__resetCloudSyncForTests(); await resetDb(); installFakeGoogle();    // "new phone": fresh profile, same Google account
  await start();
  const st = await cycle();
  assert.equal(st.state, 'choose-backup');
  assert.equal(st.backups.length, 1);
  assert.equal(G.files.size, 1, 'no second cloud file was created');
  // the user chooses to restore -> adopts dataset; next cycles are quiet
  await (await import('../js/modules/google-drive-backup.js')).restoreFromGoogleDrive('replace', { fileId: pcFile.id });
  await S.markSynced();
  assert.equal((await cycle()).state, 'idle');
});

test('B: "start a separate backup for this profile" creates a new dataset file once', async () => {
  await bank('PC', 1000); await start(); await cycle();
  S.__resetCloudSyncForTests(); await resetDb(); installFakeGoogle();
  await bank('Phone only', 5);
  await start();
  assert.equal((await cycle()).state, 'choose-backup');
  const st = await S.chooseStartFreshBackup();
  assert.equal(st.state, 'idle');
  assert.equal(G.files.size, 2);
});

test('B: the app opening with a clean, up-to-date device does NOT download or upload anything', async () => {
  await bank('Main', 1000); await start(); await cycle();
  const calls = G.calls.length;
  await cycle();
  const delta = G.calls.slice(calls);
  assert.ok(delta.every((c) => c.startsWith('GET') && c.includes('/drive/v3/files?')), delta.join('\n'));   // just the cheap list call
});

/* ---------------- failures ---------------- */
test('token expired and Google cannot answer silently -> needs-reconnect (no popup), then one tap fixes it', async () => {
  await bank('Main', 1000); await start(); await cycle();
  A.invalidateAccessToken(); G.silentOk = false; G.prompts.length = 0;
  let st = await cycle();
  assert.equal(st.state, 'needs-reconnect');
  assert.deepEqual(G.prompts, ['none'], 'background sync never opens a popup');
  G.silentOk = true;
  st = await cycle({ interactive: true });
  assert.equal(st.state, 'idle');
});

test('rate limit (403 userRateLimitExceeded / 429) -> error + scheduled retry; other 403 -> needs-reconnect', async () => {
  await bank('Main', 1000); await start();
  G.fail = { match: (m, u) => u.includes('/drive/v3/files'), status: 403, reason: 'userRateLimitExceeded', times: 1 };
  let st = await cycle();
  assert.equal(st.state, 'error');
  assert.ok(st.retryAt > Date.now(), 'a retry is scheduled');
  S.__resetCloudSyncForTests(); await start();
  G.fail = { match: (m, u) => u.includes('/drive/v3/files'), status: 403, reason: 'insufficientPermissions', times: 1 };
  st = await cycle();
  assert.equal(st.state, 'needs-reconnect');
});

test('offline -> state offline, no requests; back online -> syncs', async () => {
  await bank('Main', 1000); await start();
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
  const calls = G.calls.length;
  assert.equal((await cycle()).state, 'offline');
  assert.equal(G.calls.length, calls);
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
  assert.equal((await cycle()).state, 'idle');
  assert.equal(G.files.size, 1);
});

test('network failure mid-sync -> retry scheduled; data stays dirty so nothing is lost', async () => {
  const a = await bank('Main', 1000); await start(); await cycle();
  await createExpense({ accountId: a.id, amount: 3, category: 'Groceries' });
  G.fail = { match: (m, u) => /upload/.test(u), network: true, times: 1 };
  const st = await cycle();
  assert.ok(['error', 'offline'].includes(st.state));
  assert.equal(await (await import('../js/modules/preferences.js')).getSetting('cloudDirty', null) !== null, true);
  assert.equal((await cycle()).state, 'idle');
});

test('Web Locks: if another tab is already syncing, this tab skips (no double upload)', async () => {
  await bank('Main', 1000); await start();
  let asked = null;
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, locks: { request: async (name, opts, cb) => { asked = { name, opts }; return cb(null); } } }, configurable: true, writable: true });
  const calls = G.calls.length;
  await cycle();
  assert.equal(asked.opts.ifAvailable, true);
  assert.match(asked.name, /^finora-cloud-sync:/);
  assert.equal(G.files.size, 0);
  assert.equal(G.calls.length, calls, 'the lock is taken BEFORE any request, so a second tab makes no network call at all');
});

test('switching automatic sync OFF stops everything but keeps tracking changes', async () => {
  const a = await bank('Main', 1000); await start(); await cycle();
  await S.setAutoSyncEnabled(false);
  assert.equal(S.getSyncStatus().state, 'off');
  const calls = G.calls.length;
  await createExpense({ accountId: a.id, amount: 1, category: 'Groceries' });
  await cycle();
  assert.equal(G.calls.length, calls, 'no network while off');
  await S.setAutoSyncEnabled(true);
  assert.equal((await cycle()).state, 'idle');                            // dirty marker survived -> uploaded now
});

test('two devices end to end: phone restores once, then FOLLOWS the PC automatically', async () => {
  const pc = await bank('PC', 1000); await start(); await cycle();
  await createExpense({ accountId: pc.id, amount: 120, category: 'Groceries' }); await cycle();
  const fileId = only().id; const contentV1 = only().content;           // cloud state S1: balance 880
  await createExpense({ accountId: pc.id, amount: 80, category: 'Groceries' }); await cycle();
  const contentV2 = only().content;                                      // cloud state S2: balance 800

  // the phone: a fresh profile. Put S1 in the cloud (as it was when the phone first looked), restore it once.
  G.files.get(fileId).content = contentV1; otherDeviceWrites(fileId);
  S.__resetCloudSyncForTests(); await resetDb(); installFakeGoogle(); await start();
  assert.equal((await cycle()).state, 'choose-backup');
  await (await import('../js/modules/google-drive-backup.js')).restoreFromGoogleDrive('replace', { fileId });
  await S.markSynced();
  const phoneBal = async () => (await getAll('accounts')).find((x) => x.name === 'PC').balance;
  assert.equal(await phoneBal(), 880);

  // the PC saved S2 meanwhile; the phone is clean, so on its next check it follows by itself
  G.files.get(fileId).content = contentV2; otherDeviceWrites(fileId);
  const st = await cycle();
  assert.equal(st.state, 'idle');
  assert.equal(await phoneBal(), 800, 'the phone now shows the PC\'s latest data');
  assert.equal(applied.length, 1);

  // and the phone's own edits flow back
  await createExpense({ accountId: (await getAll('accounts')).find((x) => x.name === 'PC').id, amount: 50, category: 'Groceries' });
  const v = only().version; await cycle();
  assert.ok(Number(only().version) > Number(v));
  assert.equal((await cycle()).state, 'idle');
});

/* ---------------- gaps found while cross-checking ---------------- */
test('race: an edit made while the cloud copy is downloading is NEVER erased (becomes a conflict)', async () => {
  const a = await bank('Main', 1000); await start(); await cycle();
  otherDeviceWrites(only().id);                                          // cloud moved on, this device is clean
  const realFetch = globalThis.fetch; let edited = false;
  globalThis.fetch = async (u, o) => {
    if (!edited && String(u).includes('alt=media')) { edited = true; await createExpense({ accountId: a.id, amount: 42, category: 'Groceries' }); }
    return realFetch(u, o);
  };
  const st = await cycle();
  globalThis.fetch = realFetch;
  assert.equal(st.state, 'conflict');
  assert.equal(await balanceOf(a.id), 958, 'the edit survived');
  assert.equal(applied.length, 0);
});

test('a manual file restore marks the data as changed so it reaches the cloud', async () => {
  const a = await bank('Main', 1000); await start(); await cycle();
  const snap = { stores: await B.exportAllStores() };
  await B.restoreBackup(snap, 'replace');                                // like restoring a .finora file
  assert.equal(await (await import('../js/modules/preferences.js')).getSetting('cloudDirty', null) !== null, true);
});

test('states that need the user do not keep retrying in the background', async () => {
  const a = await bank('Main', 1000); await start(); await cycle();
  A.invalidateAccessToken(); G.silentOk = false;
  assert.equal((await cycle()).state, 'needs-reconnect');
  const calls = G.calls.length; G.prompts.length = 0;
  await createExpense({ accountId: a.id, amount: 1, category: 'Groceries' });   // would normally arm the 30 s timer
  assert.equal(S.getSyncStatus().state, 'needs-reconnect');                    // not flipped to "pending"
  assert.equal(G.prompts.length, 0);
  assert.equal(G.calls.length, calls);
});
