import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, bank, balanceOf, getAll, getById, withTransaction } from './helpers.mjs';

import * as B from '../js/modules/backup.js';
import { createAccount } from '../js/modules/accounts.js';
import { createExpense } from '../js/modules/expenses.js';
import { createIncome } from '../js/modules/income.js';
import { reverseTransaction } from '../js/core/ledger.js';
import { getCategories } from '../js/modules/categories.js';
import { todayLocal, dateInputToIso } from '../js/utils/date.js';
import { isGoogleConfigured } from '../js/modules/google-auth.js';

beforeEach(resetDb);
const year = new Date().getFullYear();
const legacyId = (n) => `TXN-${year}-${String(n).padStart(6, '0')}`;

/** Simulates "the other device": a payload whose ledger uses OLD (suffix-less) ids. */
function otherDevicePayload({ accountId, rows, extraStores = {} }) {
  return { stores: { ledger: rows.map((r, i) => ({
    id: legacyId(r.n), date: new Date().toISOString(), createdAt: `2026-01-01T00:00:0${i}Z`,
    status: 'completed', tags: [], accountId, ...r.fields,
  })), ...extraStores } };
}

test('merge: colliding legacy ids KEEP both rows (was: incoming silently dropped)', async () => {
  const a = await bank('Local', 1000);
  // local row with a legacy id
  await withTransaction(['ledger'], 'readwrite', async (tx) => {
    tx.objectStore('ledger').put({ id: legacyId(1), type: 'income', direction: 'in', amount: 10, accountId: a.id,
      date: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', description: 'LOCAL' });
  });
  const incoming = otherDevicePayload({ accountId: a.id, rows: [
    { n: 1, fields: { type: 'expense', direction: 'out', amount: 99, description: 'FROM PHONE' } },
    // a reversal that REFERENCES the colliding id must follow it to the new id
    { n: 2, fields: { type: 'expense', direction: 'in', amount: 99, description: `Reversal of ${legacyId(1)}`, parentTransactionId: legacyId(1) } },
  ] });
  await B.restoreBackup(incoming, 'merge');

  const ledger = await getAll('ledger');
  assert.ok(ledger.find((r) => r.description === 'LOCAL' && r.id === legacyId(1)), 'local row untouched');
  const phone = ledger.find((r) => r.description === 'FROM PHONE');
  assert.ok(phone, 'incoming row must survive');
  assert.notEqual(phone.id, legacyId(1));
  const rev = ledger.find((r) => r.parentTransactionId);
  assert.equal(rev.parentTransactionId, phone.id, 'reference remapped');
  assert.ok(rev.description.includes(phone.id), 'text reference remapped too');
});

test('merge: ledger counter is synced so new transactions never overwrite imported ones', async () => {
  const a = await bank('Acct', 100);
  await B.restoreBackup(otherDevicePayload({ accountId: a.id, rows: [
    { n: 6, fields: { type: 'income', direction: 'in', amount: 5, description: 'IMPORTED 6' } },
    { n: 7, fields: { type: 'income', direction: 'in', amount: 5, description: 'IMPORTED 7' } },
  ] }), 'merge');
  const before = (await getAll('ledger')).length;
  for (let i = 0; i < 10; i++) await createIncome({ accountId: a.id, amount: 1, category: 'Salary' });
  const after = await getAll('ledger');
  assert.equal(after.length, before + 10);
  assert.equal(after.filter((r) => String(r.description).startsWith('IMPORTED')).length, 2);
});

test('merge: re-restoring your own backup is idempotent', async () => {
  const a = await bank('A', 5000);
  await createExpense({ accountId: a.id, amount: 250, category: 'Groceries' });
  const snap = { stores: await B.exportAllStores() };
  const n = (await getAll('ledger')).length;
  const bal = await balanceOf(a.id);
  await B.restoreBackup(snap, 'merge');
  await B.restoreBackup(snap, 'merge');
  assert.equal((await getAll('ledger')).length, n);
  assert.equal(await balanceOf(a.id), bal);
});

test('merge: categories are NOT duplicated', async () => {
  const cats = await getCategories('expense');
  const incoming = { stores: { categories: cats.map((c) => ({ ...c, id: `other_${c.id}` })) } };
  await B.restoreBackup(incoming, 'merge');
  assert.equal((await getCategories('expense')).length, cats.length);
});

test('merge: balances are recomputed from the merged ledger', async () => {
  const a = await bank('Shared', 1000);                       // balance 1000
  const phoneCopy = { stores: await B.exportAllStores() };    // phone starts as a copy…
  await createExpense({ accountId: a.id, amount: 100, category: 'Groceries' }); // PC spends 100
  // …phone ALSO spent 40 on the same account (different row, legacy id)
  phoneCopy.stores.ledger.push({
    id: legacyId(900), type: 'expense', direction: 'out', amount: 40, accountId: a.id, category: 'Food & Dining',
    date: new Date().toISOString(), createdAt: '2026-02-02T00:00:00Z', description: 'phone spend', status: 'completed', tags: [],
  });
  await B.restoreBackup(phoneCopy, 'merge');
  assert.equal(await balanceOf(a.id), 1000 - 100 - 40);
});

test('replace: keeps THIS device id, resets nothing else wrongly', async () => {
  const a = await bank('A', 100);
  const dev = (await getById('settings', 'deviceId')).value;
  const snap = { stores: await B.exportAllStores() };
  snap.stores.settings = snap.stores.settings.map((s) => (s.key === 'deviceId' ? { ...s, value: 'zzzz' } : s));
  await B.restoreBackup(snap, 'replace');
  assert.equal((await getById('settings', 'deviceId')).value, dev);
  assert.equal(await balanceOf(a.id), 100);
});

test('restore is all-or-nothing', async () => {
  const a = await bank('A', 100);
  const bad = { stores: { ledger: [{ id: 'x' }, { notAnObject: true }], accounts: 'not-an-array' } };
  await assert.rejects(() => B.restoreBackup(bad, 'replace'));
  assert.equal(await balanceOf(a.id), 100);
});

test('encrypted backup: new = 600k PBKDF2, old 250k backups still open', async () => {
  await bank('A', 100);
  const file = await B.createEncryptedBackup('correct horse battery');
  assert.equal(JSON.parse(file).iterations, 600000);
  assert.ok((await B.decryptBackup(file, 'correct horse battery')).stores.accounts.length === 1);
  await assert.rejects(() => B.decryptBackup(file, 'wrong password!!'), /Incorrect password/);

  // hand-build a LEGACY container (250k iterations) exactly like the old code did
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await B.deriveKey('legacy-pass-1', salt, 'encrypt', 250000);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify({ stores: { accounts: [] } })));
  const legacy = JSON.stringify({ version: 2, iterations: 250000, salt: B.bufToBase64(salt), iv: B.bufToBase64(iv), ciphertext: B.bufToBase64(ct) });
  assert.deepEqual((await B.decryptBackup(legacy, 'legacy-pass-1')).stores, { accounts: [] });
  // and a container with NO iterations field falls back to 250k
  const noField = JSON.stringify({ ...JSON.parse(legacy), iterations: undefined });
  assert.ok(await B.decryptBackup(noField, 'legacy-pass-1'));
});

test('dates: local "today" and noon-anchoring (IST)', () => {
  assert.match(todayLocal(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(dateInputToIso(''), undefined);
  const past = dateInputToIso('2026-03-15');
  assert.equal(new Date(past).getHours(), 12);                           // local noon
  assert.equal(new Date(past).toLocaleDateString('en-CA'), '2026-03-15'); // never shifts a day
});

test('google: placeholder client id is NOT treated as configured', () => {
  assert.equal(isGoogleConfigured(), false);
});

/* ---------------- CSV ---------------- */
import { parseImportDate, validateImportRows, importValidRows, parseCsv } from '../js/modules/csv-import.js';

test('csv import: Indian dd/mm/yyyy and other real-world date formats', () => {
  const ymd = (d) => d && d.toLocaleDateString('en-CA');
  assert.equal(ymd(parseImportDate('15/10/2026')), '2026-10-15');
  assert.equal(ymd(parseImportDate('05-10-2026')), '2026-10-05');   // day-first
  assert.equal(ymd(parseImportDate('5.10.26')), '2026-10-05');
  assert.equal(ymd(parseImportDate('2026-10-05')), '2026-10-05');
  assert.equal(ymd(parseImportDate('10/25/2026')), '2026-10-25');   // can only be MM/DD
  assert.equal(parseImportDate('31/02/2026'), null);                 // impossible date rejected
  assert.equal(parseImportDate('garbage'), null);
});

test('csv import: duplicates are flagged and skipped by default', async () => {
  const a = await bank('HDFC', 5000);
  const csv = 'Date,Type,Amount,Category,Account,Description\n15/10/2026,expense,250,Groceries,HDFC,Milk\n';
  const first = await validateImportRows(parseCsv(csv));
  assert.equal(first[0].valid, true);
  assert.equal(first[0].duplicate, false);
  assert.deepEqual(await importValidRows(first), { imported: 1, failed: 0, skipped: 0 });

  const again = await validateImportRows(parseCsv(csv));
  assert.equal(again[0].duplicate, true);
  assert.deepEqual(await importValidRows(again), { imported: 0, failed: 0, skipped: 1 });
  assert.equal((await importValidRows(again, { includeDuplicates: true })).imported, 1);
  assert.equal(await balanceOf(a.id), 5000 - 250 - 250);
});

test('csv export: formula-injection guard on text, numbers untouched', async () => {
  const a = await bank('A', 100);
  await createExpense({ accountId: a.id, amount: 5, category: 'Groceries', description: '=HYPERLINK("http://evil","x")' });
  let captured = '';
  const orig = B.downloadTextFile;
  // exportCsv calls downloadTextFile (needs DOM) — capture the text instead
  globalThis.document = { createElement: () => ({ click() {}, remove() {}, style: {}, set href(v) {}, set download(v) {} }), body: { appendChild() {}, removeChild() {} } };
  globalThis.URL.createObjectURL = (blob) => { captured = blob; return 'blob:x'; };
  globalThis.URL.revokeObjectURL = () => {};
  await B.exportCsv('expenses');
  const text = typeof captured?.text === 'function' ? await captured.text() : String(captured);
  assert.ok(!/(^|,)"?=HYPERLINK/m.test(text), 'raw formula must not start a cell');
  assert.ok(text.includes('\t=HYPERLINK'), 'tab-prefixed instead');
});
