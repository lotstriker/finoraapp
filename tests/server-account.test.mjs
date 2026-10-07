import './setup.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getAll } from './helpers.mjs';
import { createFakeSupabase } from './fake-supabase.mjs';

const SB = await import('../js/modules/supabase-client.js');
const E2E = await import('../js/modules/e2e-crypto.js');
const ACC = await import('../js/modules/server-account.js');
const B = await import('../js/modules/backup.js');

const URL_OK = 'https://abcdefghijklmnopqrst.supabase.co';
const KEY_OK = 'sb_publishable_abc123';
let fake;
beforeEach(async () => { await resetDb(); fake = createFakeSupabase(); SB.configureSupabase({ url: URL_OK, key: KEY_OK, createClient: fake.createClient }); });

/* ---------------- config validation (secret keys must be refused) ---------------- */
const jwt = (role) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.sig`;
test('config: accepts publishable + legacy anon keys; REFUSES secret/service_role keys', () => {
  assert.equal(SB.validateSupabaseConfig({ url: URL_OK, key: KEY_OK }).ok, true);
  assert.equal(SB.validateSupabaseConfig({ url: URL_OK + '/', key: jwt('anon') }).ok, true);
  assert.match(SB.validateSupabaseConfig({ url: URL_OK, key: 'sb_secret_xyz' }).problem, /SECRET key/);
  assert.match(SB.validateSupabaseConfig({ url: URL_OK, key: jwt('service_role') }).problem, /SECRET key/);
  assert.match(SB.validateSupabaseConfig({ url: 'http://evil.com', key: KEY_OK }).problem, /should look like/);
  assert.match(SB.validateSupabaseConfig({ url: '', key: '' }).problem, /not configured/);
  assert.match(SB.validateSupabaseConfig({ url: URL_OK, key: 'hello' }).problem, /publishable/);
});

test('client: refuses to start with a secret key even if asked', async () => {
  SB.configureSupabase({ url: URL_OK, key: 'sb_secret_xyz', createClient: fake.createClient });
  await assert.rejects(() => SB.getClient(), /SECRET key/);
});

test('client: PKCE flow + session detection are requested (hash-router safe)', async () => {
  let seen;
  SB.configureSupabase({ url: URL_OK, key: KEY_OK, createClient: (u, k, opts) => { seen = { u, k, opts }; return fake.client; } });
  await SB.getClient();
  assert.equal(seen.opts.auth.flowType, 'pkce');
  assert.equal(seen.opts.auth.detectSessionInUrl, true);
  assert.equal(seen.opts.auth.persistSession, true);
  assert.equal(seen.u, URL_OK);
});

/* ---------------- auth ---------------- */
test('sign-in redirects back to the page WITHOUT the #hash route', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('', { url: 'https://saif.github.io/finora/#/reports' });
  Object.defineProperty(globalThis, 'location', { value: dom.window.location, configurable: true, writable: true });
  await SB.signInWithGoogle();
  const call = fake.state.calls.signInWithOAuth[0];
  assert.equal(call.provider, 'google');
  assert.equal(call.options.redirectTo, 'https://saif.github.io/finora/');
});

test('OAuth return: waits for the code exchange, strips ?code= but KEEPS the #hash route', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('', { url: 'https://saif.github.io/finora/?code=abc123&state=xyz#/reports' });
  for (const k of ['location', 'history']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
  const r = await SB.handleAuthReturn();
  assert.equal(r.handled, true);
  assert.equal(dom.window.location.search, '?state=xyz');            // only the single-use code is removed
  assert.equal(dom.window.location.hash, '#/reports');
  assert.equal(dom.window.location.pathname, '/finora/');
});

test('OAuth return: an error from Google is reported, not thrown, and cleaned from the URL', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('', { url: 'https://saif.github.io/finora/?error=access_denied&error_description=User+cancelled#/dashboard' });
  for (const k of ['location', 'history']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
  const r = await SB.handleAuthReturn();
  assert.match(r.error, /cancelled/);
  assert.equal(dom.window.location.search, '');
});

test('OAuth return: a normal page load does nothing', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('', { url: 'https://saif.github.io/finora/#/dashboard' });
  for (const k of ['location', 'history']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
  assert.deepEqual(await SB.handleAuthReturn(), { handled: false });
});

/* ---------------- E2E crypto ---------------- */
test('e2e: round-trip; AAD binds a ciphertext to its record; tampering is detected', async () => {
  const { key } = await E2E.createEncryption('correct horse battery staple');
  const rec = { id: 'TXN-1', amount: 250.5, description: 'चाय ☕' };
  const ct = await E2E.encryptValue(key, rec, E2E.recordAad('ds1', 'ledger', 'TXN-1'));
  assert.deepEqual(await E2E.decryptValue(key, ct, E2E.recordAad('ds1', 'ledger', 'TXN-1')), rec);
  assert.ok(!ct.includes('250') && !ct.includes('TXN'), 'plaintext is not visible');
  // a server moving this ciphertext to another record / dataset / store must fail
  for (const aad of [E2E.recordAad('ds1', 'ledger', 'TXN-2'), E2E.recordAad('ds2', 'ledger', 'TXN-1'), E2E.recordAad('ds1', 'accounts', 'TXN-1')]) {
    await assert.rejects(() => E2E.decryptValue(key, ct, aad), (e) => e.code === 'decrypt-failed');
  }
  const bytes = E2E.fromB64(ct); bytes[bytes.length - 1] ^= 1;
  await assert.rejects(() => E2E.decryptValue(key, E2E.toB64(bytes), E2E.recordAad('ds1', 'ledger', 'TXN-1')), (e) => e.code === 'decrypt-failed');
});

test('e2e: every encryption uses a fresh random IV (same data -> different ciphertext)', async () => {
  const { key } = await E2E.createEncryption('correct horse battery staple');
  const a = await E2E.encryptValue(key, { x: 1 }, 'a'); const b = await E2E.encryptValue(key, { x: 1 }, 'a');
  assert.notEqual(a, b);
});

test('e2e: passphrase rules', () => {
  assert.equal(E2E.assessPassphrase('short').ok, false);
  assert.equal(E2E.assessPassphrase('aaaaaaaaaaaa').ok, false);
  assert.equal(E2E.assessPassphrase('password123456').ok, false);
  assert.equal(E2E.assessPassphrase('mango river cricket lamp').ok, true);
});

test('e2e: server profile does not contain the key or the passphrase', async () => {
  const { profile } = await E2E.createEncryption('mango river cricket lamp');
  const json = JSON.stringify(profile);
  assert.ok(!json.includes('mango') && !json.includes('cricket'));
  assert.equal(profile.kdf_iterations, 600000);
});

/* ---------------- setup flow: first device, second device ---------------- */
test('setup: signed out -> create (first device) -> ready; salt+verifier are stored server-side, key locally', async () => {
  fake.state.session = null;
  assert.equal((await ACC.getSetupState()).state, 'signed-out');
  fake.state.session = { user: { id: 'user-1' } };
  assert.equal((await ACC.getSetupState()).state, 'needs-create');
  await assert.rejects(() => ACC.setUpEncryption('short'), (e) => e.code === 'weak-passphrase');
  await ACC.setUpEncryption('mango river cricket lamp');
  assert.equal(fake.state.tables.sync_profiles.length, 1);
  assert.equal((await ACC.getSetupState()).state, 'ready');
  const stored = await ACC.loadLocalKey('user-1');
  assert.equal(stored.extractable, false, 'raw key bytes are not readable by JavaScript');
});

test('setup: a second device must enter the SAME passphrase; the wrong one is rejected; the right one gets the same key', async () => {
  await ACC.setUpEncryption('mango river cricket lamp');
  const serverProfile = fake.state.tables.sync_profiles[0];
  const deviceA = await ACC.loadLocalKey('user-1');
  const ctA = await E2E.encryptValue(deviceA, { hello: 'from A' }, 'aad');

  await resetDb();                                                     // "device B": fresh local DB, same account
  assert.equal((await ACC.getSetupState()).state, 'needs-unlock');
  await assert.rejects(() => ACC.unlockWithPassphrase('wrong passphrase here'), (e) => e.code === 'wrong-passphrase');
  assert.equal((await ACC.getSetupState()).state, 'needs-unlock', 'still locked after a wrong try');
  await ACC.unlockWithPassphrase('mango river cricket lamp');
  assert.equal((await ACC.getSetupState()).state, 'ready');
  const deviceB = await ACC.loadLocalKey('user-1');
  assert.deepEqual(await E2E.decryptValue(deviceB, ctA, 'aad'), { hello: 'from A' });   // B reads what A encrypted
  assert.equal(fake.state.tables.sync_profiles.length, 1, 'no second profile was created');
});

test('setup: cannot create a second passphrase for the same account', async () => {
  await ACC.setUpEncryption('mango river cricket lamp');
  await assert.rejects(() => ACC.setUpEncryption('another long passphrase'), (e) => e.code === 'already-exists');
});

test('a key stored for user A is NOT used for user B on a shared browser', async () => {
  await ACC.setUpEncryption('mango river cricket lamp');
  fake.state.session = { user: { id: 'user-2' } };
  assert.equal(await ACC.loadLocalKey('user-2'), null);
  assert.equal((await ACC.getSetupState()).state, 'needs-create');
});

test('the E2E key never ends up in backups or the Drive hash', async () => {
  await ACC.setUpEncryption('mango river cricket lamp');
  const keys = (await B.exportAllStores()).settings.map((s) => s.key);
  assert.ok(!keys.includes('e2eKey'));
});

test('lockThisDevice forgets the key here only', async () => {
  await ACC.setUpEncryption('mango river cricket lamp');
  await ACC.lockThisDevice();
  assert.equal(await ACC.loadLocalKey('user-1'), null);
  assert.equal(fake.state.tables.sync_profiles.length, 1, 'the server profile stays');
});
