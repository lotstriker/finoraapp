import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './setup.mjs';
import { resetDb, bank, getAll } from './helpers.mjs';
import { G, resetGoogle, installFakeGoogle, otherDeviceWrites } from './fake-google.mjs';

installFakeGoogle();
const A = await import('../js/modules/google-auth.js');
const D = await import('../js/modules/google-drive-backup.js');
const B = await import('../js/modules/backup.js');

beforeEach(async () => { resetGoogle(); await resetDb(); installFakeGoogle(); A.invalidateAccessToken(); });
const only = () => [...G.files.values()][0];

/* ---------------- auth (cross-checked with the GIS reference) ---------------- */
test('auth: placeholder client id is not configured; a real-shaped one is', () => {
  A.configureGoogleClient('PASTE_YOUR_CLIENT_ID_HERE'); assert.equal(A.isGoogleConfigured(), false);
  A.configureGoogleClient('123456-test.apps.googleusercontent.com'); assert.equal(A.isGoogleConfigured(), true);
});

test('auth: a half-granted consent (Drive box unticked) is rejected', async () => {
  G.grantAll = false;
  await assert.rejects(() => A.connectGoogleAccount(), /Drive access was not granted/);
  assert.equal(A.getAccessToken(), null);
});

test('auth: silent reconnect uses prompt "none"; interactive refresh inside a click uses ""; login_hint is sent', async () => {
  await A.trySilentReconnect();
  assert.deepEqual(G.prompts, ['none']);
  assert.equal(G.hints[0], 'me@example.com');            // docs: login_hint skips account selection
  A.invalidateAccessToken();
  await D.backupToGoogleDrive();
  assert.equal(G.prompts.at(-1), '');
});

test('auth: background (non-interactive) requests never use a popup prompt', async () => {
  A.invalidateAccessToken();
  await D.listCloudBackups({ interactive: false });
  assert.deepEqual(G.prompts, ['none']);
});

/* ---------------- backup / restore ---------------- */
test('drive: first backup creates a per-dataset file with version; second updates it', async () => {
  await bank('A', 500);
  await D.backupToGoogleDrive();
  assert.equal(G.files.size, 1);
  assert.match(only().name, /^finora-dataset-ds_/);
  assert.equal(only().appProperties.app, 'finora');
  const v1 = only().version;
  await B.recordBackupCompleted();
  const { withTransaction } = await import('../js/core/db.js');
  await withTransaction(['accounts'], 'readwrite', (tx) => { /* real change so the hash differs */ });
  await bank('B', 1);
  await D.backupToGoogleDrive();
  assert.equal(G.files.size, 1, 'same file updated, not duplicated');
  assert.ok(Number(only().version) > Number(v1));
});

test('drive: two PROFILES (two dataset ids) get two files', async () => {
  await bank('A', 500);
  await D.backupToGoogleDrive();
  await B.setDatasetId('ds_otherprofile'); await B.setCloudSync(null);
  await D.backupToGoogleDrive();
  assert.equal(G.files.size, 2);
});

test('drive: conflict uses the file VERSION (not a clock) and force overwrites', async () => {
  await bank('A', 500);
  await D.backupToGoogleDrive();
  otherDeviceWrites(only().id);                                   // another device uploaded
  await assert.rejects(() => D.backupToGoogleDrive(), (e) => e.name === 'CloudConflictError' && e.reason === 'remote-changed');
  await D.backupToGoogleDrive({ force: true });
  await D.backupToGoogleDrive();                                  // in sync again (no throw)
});

test('drive: cloud file exists but no local sync record -> conflict (unknown state)', async () => {
  await bank('A', 500);
  await D.backupToGoogleDrive();
  await B.setCloudSync(null);
  await assert.rejects(() => D.backupToGoogleDrive(), (e) => e.name === 'CloudConflictError' && e.reason === 'unknown-state');
});

test('drive: skipIfUnchanged uploads nothing when the data is identical', async () => {
  await bank('A', 500);
  await D.backupToGoogleDrive();
  const before = G.calls.length;
  const r = await D.backupToGoogleDrive({ skipIfUnchanged: true });
  assert.equal(r.skipped, true);
  assert.ok(!G.calls.slice(before).some((c) => c.startsWith('POST') || c.startsWith('PATCH')), 'no upload');
});

test('drive: LARGE backups (> 4 MB) use the resumable upload (PATCH to update) and round-trip', async () => {
  const a = await bank('A', 500);
  const { withTransaction } = await import('../js/core/db.js');
  await withTransaction(['ledger'], 'readwrite', (tx) => tx.objectStore('ledger').put({
    id: 'TXN-2026-999999-big', type: 'income', direction: 'in', amount: 1, accountId: a.id, date: new Date().toISOString(),
    createdAt: new Date().toISOString(), description: 'x', attachment: { dataUrl: 'A'.repeat(5_000_000) },
  }));
  await D.backupToGoogleDrive();
  assert.ok(G.calls.some((c) => c.includes('uploadType=resumable')));
  assert.ok(G.calls.some((c) => c.startsWith('PUT https://upload.session/')));
  // update path: must be PATCH (docs: PUT returns no session Location)
  await bank('B', 1); G.calls.length = 0;
  await D.backupToGoogleDrive();
  assert.ok(G.calls.some((c) => c.startsWith('PATCH') && c.includes('uploadType=resumable')), G.calls.join('\n'));
  const r = await D.restoreFromGoogleDrive('replace', { fileId: only().id });
  assert.equal(r.storageType, 'dataset');
  assert.ok((await getAll('ledger')).some((t) => t.id === 'TXN-2026-999999-big'));
});

test('drive: restore adopts the dataset id and records the sync point (no false conflict afterwards)', async () => {
  await bank('PC account', 700);
  await D.backupToGoogleDrive();
  const pcDataset = await B.getDatasetId(); const fileId = only().id;
  await resetDb();
  assert.notEqual(await B.getDatasetId(), pcDataset);
  await D.restoreFromGoogleDrive('replace', { fileId });
  assert.equal(await B.getDatasetId(), pcDataset);
  assert.equal((await getAll('accounts')).some((x) => x.name === 'PC account'), true);
  const r = await D.backupToGoogleDrive({ skipIfUnchanged: true });     // identical to what we restored
  assert.equal(r.skipped, true);
  assert.equal(G.files.size, 1);
});

test('drive: several backups and no choice -> CloudChoiceRequired', async () => {
  await bank('A', 1); await D.backupToGoogleDrive();
  await B.setDatasetId('ds_two'); await B.setCloudSync(null); await D.backupToGoogleDrive();
  await resetDb();
  await assert.rejects(() => D.restoreFromGoogleDrive('merge'), (e) => e.name === 'CloudChoiceRequired' && e.backups.length === 2);
});

test('drive: device-local keys never travel inside backups', async () => {
  await bank('A', 1);
  await B.setCloudSync({ x: 1 }); await B.setDatasetId('ds_x');
  const keys = (await B.exportAllStores()).settings.map((s) => s.key);
  for (const k of ['deviceId', 'cloudSync', 'autoSync', 'cloudDirty', 'cloudStartFresh']) assert.ok(!keys.includes(k), k);
  assert.ok(keys.includes('datasetId'), 'datasetId DOES travel (that is how devices find the same file)');
});

/* ---------------- docs-driven fixes ---------------- */
test('drive: appProperties respect the 124-BYTE limit even for Hindi / emoji profile names', async () => {
  const hindi = 'मेरा निजी खाता और बहुत लंबा नाम जो सौ से ज़्यादा बाइट का है 🙂🙂🙂🙂';
  const props = D.buildAppProperties({ datasetId: 'ds_abc123def456', profileName: hindi });
  for (const [k, v] of Object.entries(props)) {
    assert.ok(new TextEncoder().encode(k + v).length <= D.APP_PROPERTY_MAX_BYTES, `${k} is ${new TextEncoder().encode(k + v).length} bytes`);
  }
  assert.ok(props.profileName.length > 5, 'still keeps a useful prefix');
  assert.equal(D.truncateUtf8('🙂🙂🙂', 5), '🙂');                 // never splits a character
  // end-to-end: the fake Drive (like the real one) rejects over-long properties
  const { getActiveProfile } = await import('../js/modules/profiles.js');
  const orig = getActiveProfile();
  await bank('A', 1);
  await D.backupToGoogleDrive();                                    // would 400 with the old 60-CHARACTER slice if the name were long Hindi
});

test('drive: errors are classified per the Drive docs (rate 403/429 retryable; other 403 is permission)', async () => {
  await bank('A', 1);
  const kinds = async (status, reason) => {
    G.fail = { match: (m, u) => u.includes('/drive/v3/files'), status, reason, times: 1 };
    try { await D.listCloudBackups(); } catch (e) { return [e.kind, e.retryable]; }
  };
  assert.deepEqual(await kinds(403, 'userRateLimitExceeded'), ['rate', true]);
  assert.deepEqual(await kinds(403, 'rateLimitExceeded'), ['rate', true]);
  assert.deepEqual(await kinds(429, ''), ['rate', true]);
  assert.deepEqual(await kinds(503, 'backendError'), ['server', true]);
  assert.deepEqual(await kinds(403, 'insufficientPermissions'), ['scope', false]);
  assert.deepEqual(await kinds(404, 'notFound'), ['notfound', false]);
  assert.deepEqual(await kinds(400, 'badRequest'), ['other', false]);
  G.fail = { match: () => true, network: true, times: 1 };
  await assert.rejects(() => D.listCloudBackups(), (e) => e.kind === 'network' && e.retryable);
});

test('drive: a 401 mid-session refreshes the token once and retries', async () => {
  await bank('A', 1);
  G.fail = { match: (m, u) => u.includes('/drive/v3/files'), status: 401, times: 1 };
  const list = await D.listCloudBackups();
  assert.deepEqual(list, []);
  assert.ok(G.tokens >= 2, 'a second token was requested');
});
