import './setup.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFakeSupabase } from './fake-supabase.mjs';

const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { url: 'https://saif.github.io/finora/#/settings', pretendToBeVisual: true });
for (const k of ['document', 'location', 'history', 'HTMLElement']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });

const { resetDb } = await import('./helpers.mjs');
const SB = await import('../js/modules/supabase-client.js');
const { renderServerSyncCard } = await import('../js/pages/server-sync-ui.js');
const ACC = await import('../js/modules/server-account.js');

let fake;
const host = () => document.querySelector('#host');
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const click = async (sel) => { host().querySelector(sel).click(); await tick(900); };   // PBKDF2 (600k) takes a moment
const fill = (sel, v) => { host().querySelector(sel).value = v; };

beforeEach(async () => {
  await resetDb(); host().innerHTML = '';
  fake = createFakeSupabase({ signedIn: false });
  SB.configureSupabase({ url: 'https://abcdefghijklmnopqrst.supabase.co', key: 'sb_publishable_abc', createClient: fake.createClient });
});

test('card: not configured -> explains what to do (no crash, no login button)', async () => {
  SB.configureSupabase({ url: '', key: '' });
  await renderServerSyncCard(host());
  assert.match(host().textContent, /not configured/i);
  assert.equal(host().querySelector('#ss-signin'), null);
});

test('card: a SECRET key in config.js is called out', async () => {
  SB.configureSupabase({ url: 'https://abcdefghijklmnopqrst.supabase.co', key: 'sb_secret_oops' });
  await renderServerSyncCard(host());
  assert.match(host().textContent, /SECRET key/);
});

test('card: signed out -> Sign in with Google starts the PKCE redirect flow', async () => {
  await renderServerSyncCard(host());
  assert.match(host().textContent, /Step 1 of 2/);
  await click('#ss-signin');
  assert.equal(fake.state.calls.signInWithOAuth[0].provider, 'google');
});

test('card: first device -> passphrase rules, mismatch, acknowledgement are all enforced; then ready', async () => {
  fake.state.session = { user: { id: 'user-1', email: 'saif@example.com' } };
  await renderServerSyncCard(host());
  assert.match(host().textContent, /choose an encryption passphrase/);
  assert.match(host().textContent, /saif@example.com/);
  const toasts = () => [...document.querySelectorAll('.toast, .modal-error')].map((t) => t.textContent).join('|');

  fill('#ss-pass', 'short'); fill('#ss-pass2', 'short'); await click('#ss-create');
  assert.match(toasts(), /at least 10/);
  fill('#ss-pass', 'mango river cricket lamp'); fill('#ss-pass2', 'different one entirely'); await click('#ss-create');
  assert.match(toasts(), /do not match/);
  fill('#ss-pass2', 'mango river cricket lamp'); await click('#ss-create');
  assert.match(toasts(), /tick the box/);
  assert.equal(fake.state.tables.sync_profiles.length, 0, 'nothing saved yet');

  host().querySelector('#ss-ack').checked = true; await click('#ss-create');
  assert.equal(fake.state.tables.sync_profiles.length, 1);
  assert.match(host().textContent, /encryption is ready on this device/);
});

test('card: second device -> wrong passphrase rejected, right one unlocks; Lock this device works', async () => {
  fake.state.session = { user: { id: 'user-1', email: 'saif@example.com' } };
  await ACC.setUpEncryption('mango river cricket lamp');
  await resetDb();                                                        // fresh device
  await renderServerSyncCard(host());
  assert.match(host().textContent, /Enter your encryption passphrase/);
  fill('#ss-pass', 'not the passphrase'); await click('#ss-unlock');
  assert.match(host().textContent, /Enter your encryption passphrase/, 'still locked');
  fill('#ss-pass', 'mango river cricket lamp'); await click('#ss-unlock');
  assert.match(host().textContent, /ready on this device/);
  await click('#ss-lock');
  assert.match(host().textContent, /Enter your encryption passphrase/);
});

test('card: if the server is unreachable/paused it says so (free plan pauses after 1 week of inactivity)', async () => {
  fake.state.session = { user: { id: 'user-1' } };
  fake.client.from = () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'Failed to fetch' } }) }) });
  await renderServerSyncCard(host());
  assert.match(host().textContent, /paused/i);
  assert.match(host().textContent, /offline/i);
});
