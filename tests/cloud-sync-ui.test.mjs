import './setup.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { G, resetGoogle, installFakeGoogle, otherDeviceWrites } from './fake-google.mjs';

const dom = new JSDOM('<!doctype html><body><button id="sync-chip" hidden><span class="sync-dot"></span><span class="sync-chip-label"></span></button><div id="mount"></div></body>', { url: 'http://localhost/#/settings', pretendToBeVisual: true });
for (const k of ['document', 'location', 'history', 'CustomEvent', 'HTMLElement']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
installFakeGoogle();                                   // sets globalThis.window = globalThis (+ google)
// `window` here is globalThis (fake-google); give it the event methods of the jsdom window
for (const m of ['addEventListener', 'removeEventListener', 'dispatchEvent']) globalThis[m] = dom.window[m].bind(dom.window);
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });

const { resetDb, bank } = await import('./helpers.mjs');
const S = await import('../js/modules/cloud-sync.js');
const UI = await import('../js/pages/cloud-sync-ui.js');
const { closeModal } = await import('../js/core/modal.js');
const { renderSettingsPage } = await import('../js/pages/settings-page.js');
const A = await import('../js/modules/google-auth.js');

const chip = () => document.querySelector('#sync-chip');
const label = () => chip().querySelector('.sync-chip-label').textContent;
const only = () => [...G.files.values()][0];
let unsubUi;

beforeEach(async () => {
  closeModal(); S.__resetCloudSyncForTests(); resetGoogle(); await resetDb(); installFakeGoogle(); A.invalidateAccessToken();
  document.querySelector('#mount').innerHTML = ''; unsubUi?.(); document.querySelector('#sync-chip').replaceWith(document.querySelector('#sync-chip').cloneNode(true));
  document.querySelector('#sync-chip').hidden = true;
});
afterEach(() => { S.stopCloudSync(); unsubUi?.(); });

test('relativeTime + statusText', () => {
  const now = Date.UTC(2026, 9, 5, 12);
  assert.equal(UI.relativeTime(new Date(now - 20_000).toISOString(), now), 'just now');
  assert.equal(UI.relativeTime(new Date(now - 5 * 60_000).toISOString(), now), '5 min ago');
  assert.equal(UI.relativeTime(new Date(now - 3 * 3600_000).toISOString(), now), '3 h ago');
  assert.match(UI.statusText({ state: 'conflict' }), /unsaved changes/);
  assert.match(UI.statusText({ state: 'needs-reconnect', message: 'x' }), /Tap to reconnect/);
});

test('chip: hidden when sync is off, shows TEXT labels (not just colour) per state', async () => {
  unsubUi = UI.initCloudSyncUI();
  assert.equal(chip().hidden, true);
  await bank('Main', 100);
  await S.initCloudSync();
  await S.runSyncCycle();
  assert.equal(chip().hidden, false);
  assert.equal(label(), 'Synced');
  assert.equal(chip().dataset.state, 'idle');
  assert.match(chip().getAttribute('aria-label'), /Cloud sync: Synced/);
  G.silentOk = false; A.invalidateAccessToken();
  await S.runSyncCycle();
  assert.equal(label(), 'Reconnect');
});

test('chip click: Reconnect uses a popup-capable prompt (user gesture) and then syncs', async () => {
  unsubUi = UI.initCloudSyncUI();
  await bank('Main', 100); await S.initCloudSync(); await S.runSyncCycle();
  G.silentOk = false; A.invalidateAccessToken(); await S.runSyncCycle();
  assert.equal(label(), 'Reconnect');
  G.silentOk = true; G.prompts.length = 0;
  chip().click();
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(G.prompts.includes(''), `prompts: ${G.prompts}`);
  assert.equal(label(), 'Synced');
});

test('chip click on Conflict opens the "Cloud backup is newer" dialog; Overwrite requires confirmation', async () => {
  unsubUi = UI.initCloudSyncUI();
  const a = await bank('Main', 100); await S.initCloudSync(); await S.runSyncCycle();
  otherDeviceWrites(only().id);
  const { createExpense } = await import('../js/modules/expenses.js');
  await createExpense({ accountId: a.id, amount: 5, category: 'Groceries' });
  await S.runSyncCycle();
  assert.equal(label(), 'Conflict');
  chip().click();
  assert.match(document.querySelector('.modal-header h2').textContent, /Cloud backup is newer/);
  const names = [...document.querySelectorAll('.modal-footer button')].map((b) => b.textContent);
  assert.deepEqual(names, ['Cancel', 'Overwrite cloud', 'Merge first']);
  const before = G.calls.length;
  [...document.querySelectorAll('.modal-footer button')].find((b) => b.textContent === 'Overwrite cloud').click();
  await new Promise((r) => setTimeout(r, 50));
  assert.match(document.querySelector('.modal-header h2').textContent, /Overwrite the cloud backup\?/);
  assert.ok(!G.calls.slice(before).some((c) => /^(POST|PATCH)/.test(c)), 'nothing is uploaded until confirmed');
});

test('chip click on Choose backup opens the choice dialog with Restore / Start separate', async () => {
  unsubUi = UI.initCloudSyncUI();
  await bank('PC', 100); await S.initCloudSync(); await S.runSyncCycle();
  S.__resetCloudSyncForTests(); await resetDb(); installFakeGoogle(); unsubUi(); unsubUi = UI.initCloudSyncUI();
  await S.initCloudSync(); await S.runSyncCycle();
  assert.equal(label(), 'Choose backup');
  chip().click();
  assert.match(document.querySelector('.modal-header h2').textContent, /Backups found/);
  assert.deepEqual([...document.querySelectorAll('.modal-footer button')].map((b) => b.textContent), ['Not now', 'Start separate backup', 'Restore one…']);
});

test('Settings card: automatic-sync switch persists, Sync now works, status line is live', async () => {
  await bank('Main', 100); await S.initCloudSync();
  document.body.insertAdjacentHTML('beforeend', '<div id="st-google-backup-content"></div>');
  const mount = document.querySelector('#mount');
  await renderSettingsPage(mount);
  // wait for the async Google card
  for (let i = 0; i < 40 && !document.querySelector('#st-auto-sync'); i++) await new Promise((r) => setTimeout(r, 25));
  const box = document.querySelector('#st-auto-sync');
  assert.ok(box, 'automatic sync checkbox rendered');
  for (let i = 0; i < 40 && !box.checked; i++) await new Promise((r) => setTimeout(r, 25));   // the switch fills in asynchronously
  assert.equal(box.checked, true, 'default ON');
  box.checked = false; box.dispatchEvent(new dom.window.Event('change'));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await S.isAutoSyncEnabled(), false);
  assert.match(document.querySelector('#st-sync-status').textContent, /off/i);
  box.checked = true; box.dispatchEvent(new dom.window.Event('change'));
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(await S.isAutoSyncEnabled(), true);
  assert.ok(document.querySelector('#btn-sync-now'));
});
