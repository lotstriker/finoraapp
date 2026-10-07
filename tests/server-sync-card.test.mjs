import './setup.mjs';
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer, clientFor } from './pg-supabase.mjs';

const dom = new JSDOM('<!doctype html><body><button id="sync-chip" hidden><span class="sync-dot"></span><span class="sync-chip-label"></span></button><div id="host"></div></body>', { url: 'https://saif.github.io/finora/#/settings', pretendToBeVisual: true });
for (const k of ['document', 'location', 'history', 'HTMLElement', 'CustomEvent']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
Object.defineProperty(globalThis, 'window', { value: Object.assign(globalThis, { addEventListener: dom.window.addEventListener.bind(dom.window), removeEventListener: dom.window.removeEventListener.bind(dom.window), dispatchEvent: dom.window.dispatchEvent.bind(dom.window) }), configurable: true, writable: true });

const U1 = '11111111-1111-1111-1111-111111111111';
const { openDB, closeDB, getAll } = await import('../js/core/db.js');
const { getProfiles, createProfile, switchProfile } = await import('../js/modules/profiles.js');
const { seedDefaultCategories } = await import('../js/modules/categories.js');
const { createAccount } = await import('../js/modules/accounts.js');
const B = await import('../js/modules/backup.js');
const C = await import('../js/modules/e2e-crypto.js');
const SB = await import('../js/modules/supabase-client.js');
const SS = await import('../js/modules/server-sync.js');
const CS = await import('../js/modules/cloud-sync.js');
const { renderServerSyncCard } = await import('../js/pages/server-sync-ui.js');
const { initCloudSyncUI } = await import('../js/pages/cloud-sync-ui.js');
const { closeModal } = await import('../js/core/modal.js');

let server; let key; let unsubChip;
const host = () => document.querySelector('#host');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 5000) => { const t0 = Date.now(); for (;;) { if (await cond()) return; if (Date.now() - t0 > ms) throw new Error(`timed out: ${cond}`); await tick(15); } };
const modalButton = (label) => [...document.querySelectorAll('.modal-footer button')].find((b) => b.textContent === label);

async function boot(name, { dataset = 'ds_card' } = {}) {
  await closeDB();
  const p = getProfiles().find((x) => x.name === name) || createProfile({ name });
  switchProfile(p.id); await openDB(); await B.deleteAllData(); await seedDefaultCategories();
  await C.saveLocalKey(key, U1); await B.setDatasetId(dataset);
  const client = clientFor(server, U1, name);
  SB.configureSupabase({ url: 'https://abcdefghijklmnopqrst.supabase.co', key: 'sb_publishable_abc', createClient: () => client });
}

before(async () => { key = (await C.createEncryption('mango river cricket lamp')).key; });
beforeEach(async () => {
  server = await createServer([U1]); closeModal(); host().innerHTML = '';
  Object.assign(SS.TIMING, { debounce: 50, maxWait: 300, realtime: 20, pollNoRealtime: 100000, pollWithRealtime: 100000, busyRetry: 50, startup: 10 });
  SS.__resetServerSyncForTests(); CS.__resetCloudSyncForTests();
  document.querySelector('#sync-chip').hidden = true;
});
afterEach(async () => { unsubChip?.(); await SS.stopServerSync(); await CS.stopCloudSync(); closeModal(); });

test('card: first device -> "Start syncing this device\'s data" -> confirm -> live sync is ON and data is on the server', async () => {
  await boot('dev-1'); await createAccount({ name: 'Main', type: 'bank', initialBalance: 500 });
  await SS.startServerSync();
  await renderServerSyncCard(host());
  assert.match(host().textContent, /encryption is ready on this device/);
  assert.match(host().querySelector('#ss-dataset').textContent, /Start syncing this device/);
  host().querySelector('#ss-start').click(); await tick(60);
  assert.match(document.querySelector('.modal-header h2').textContent, /Start live sync/);
  modalButton('Start').click();
  await waitFor(() => /live sync is on/i.test(host().textContent));
  assert.equal(await SS.isServerSyncEnabled(), true);
  assert.ok((await server.db.query('select count(*)::int as n from public.sync_records')).rows[0].n > 5);
  assert.match(host().querySelector('#ss-status').textContent, /Live|Synced/);
});

test('card: enabling live sync turns the Drive auto-backup OFF (two syncs would fight)', async () => {
  await boot('dev-1'); await createAccount({ name: 'Main', type: 'bank', initialBalance: 1 });
  await SS.startServerSync();
  await renderServerSyncCard(host());
  host().querySelector('#ss-start').click(); await tick(60); modalButton('Start').click();
  await waitFor(() => /live sync is on/i.test(host().textContent));
  assert.equal(await CS.isAutoSyncEnabled(), false);
});

test('card: a NEW device sees the existing data and JOINS it (record count + date shown)', async () => {
  await boot('dev-1', { dataset: 'ds_pcdata' }); await createAccount({ name: 'PC Wallet', type: 'cash', initialBalance: 321 });
  await SS.startServerSync(); await SS.enableServerSync();
  await SS.stopServerSync(); SS.__resetServerSyncForTests();

  await boot('dev-2', { dataset: 'ds_phone_own' });                     // fresh phone, its own random dataset id
  await SS.startServerSync();
  await renderServerSyncCard(host());
  const select = host().querySelector('#ss-dataset');
  assert.match(select.textContent, /Join existing data — \d+ records/);
  assert.equal(select.value, 'ds_pcdata', 'joining the existing data is the default');
  host().querySelector('#ss-start').click(); await tick(60); modalButton('Start').click();
  await waitFor(() => /live sync is on/i.test(host().textContent));
  assert.equal(await B.getDatasetId(), 'ds_pcdata');
  assert.equal((await getAll('accounts')).find((a) => a.name === 'PC Wallet').balance, 321);
});

test('card: Stop syncing turns it off here only; the card goes back to the start screen', async () => {
  await boot('dev-1'); await createAccount({ name: 'Main', type: 'bank', initialBalance: 1 });
  await SS.startServerSync(); await SS.enableServerSync();
  await renderServerSyncCard(host());
  assert.match(host().textContent, /live sync is on/i);
  const n = (await server.db.query('select count(*)::int as n from public.sync_records')).rows[0].n;
  host().querySelector('#ss-stop').click();
  await waitFor(() => host().querySelector('#ss-start'));
  assert.equal(await SS.isServerSyncEnabled(), false);
  assert.equal((await server.db.query('select count(*)::int as n from public.sync_records')).rows[0].n, n, 'server data untouched');
});

test('conflicts are surfaced: the card says how many edits were replaced and lists them', async () => {
  await boot('dev-1'); const a = await createAccount({ name: 'Wallet', type: 'cash', initialBalance: 1 });
  await SS.startServerSync(); await SS.enableServerSync();
  const { withTransaction } = await import('../js/core/db.js');
  await withTransaction(['accounts'], 'readwrite', (tx) => { tx.objectStore('accounts').put({ ...a, name: 'Wallet (my edit)' }); }, { quiet: true });   // unsynced local edit
  // meanwhile another device renamed the same account
  const remote = clientFor(server, U1, 'other');
  const payload = await C.encryptValue(key, { ...a, name: 'Wallet (their edit)' }, C.recordAad('ds_card', 'accounts', a.id));
  await remote.rpc('sync_push', { p_dataset: 'ds_card', p_device: 'other-dev', p_items: [{ store: 'accounts', record_id: a.id, base_rev: 1, deleted: false, payload }] });
  await SS.runServerSync({ reason: 'test' });
  assert.equal(SS.getServerSyncStatus().conflicts, 1);
  await renderServerSyncCard(host());
  assert.match(host().textContent, /1 of your edits were replaced/);
  host().querySelector('#ss-conflicts').click(); await tick(60);
  const modalText = document.querySelector('.modal').textContent;
  assert.match(modalText, /Wallet \(my edit\)/, 'your overwritten version is shown');
  assert.match(modalText, /edited on another device/);
});

test('chip: shows LIVE server sync when it is on (label + tooltip), falls back to Drive when it is off', async () => {
  await boot('dev-1'); await createAccount({ name: 'Main', type: 'bank', initialBalance: 1 });
  unsubChip = initCloudSyncUI();
  const chip = document.querySelector('#sync-chip');
  assert.equal(chip.hidden, true);
  await SS.startServerSync(); await SS.enableServerSync();
  await waitFor(() => SS.getServerSyncStatus().realtime === true);
  assert.equal(chip.hidden, false);
  assert.equal(chip.dataset.source, 'server');
  assert.equal(chip.querySelector('.sync-chip-label').textContent, 'Live');
  assert.match(chip.title, /Live — changes from your other devices/);
  assert.match(chip.getAttribute('aria-label'), /Live sync: Live/);
  await SS.disableServerSync();
  assert.equal(chip.hidden, true, 'no active sync -> no chip');
});

test('chip: needs-signin / needs-unlock are shown in plain words', async () => {
  await boot('dev-1'); await createAccount({ name: 'Main', type: 'bank', initialBalance: 1 });
  unsubChip = initCloudSyncUI();
  await SS.startServerSync(); await B.setDatasetId('ds_card');
  await C.forgetLocalKey();
  await SS.enableServerSync();
  const chip = document.querySelector('#sync-chip');
  assert.equal(chip.querySelector('.sync-chip-label').textContent, 'Unlock');
  assert.match(chip.title, /passphrase/);
});
