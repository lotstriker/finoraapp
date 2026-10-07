import './setup.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div id="mount"></div></body>', { url: 'http://localhost/#/dashboard', pretendToBeVisual: true });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.history = dom.window.history; globalThis.location = dom.window.location; globalThis.CustomEvent = dom.window.CustomEvent;

const { resetDb, bank, balanceOf, getAll, getById } = await import('./helpers.mjs');
const L = await import('../js/core/ledger.js');
const { createExpense } = await import('../js/modules/expenses.js');
const { createIncome } = await import('../js/modules/income.js');
const B = await import('../js/modules/backup.js');
const Loans = await import('../js/modules/loans.js');
const People = await import('../js/modules/people.js');
const Savings = await import('../js/modules/savings.js');
const Committees = await import('../js/modules/committees.js');
const { openModal, closeModal, showModalError } = await import('../js/core/modal.js');
const { toast } = await import('../js/core/toast.js');
const { renderDashboard, sparkline } = await import('../js/pages/dashboard.js');
const { setBudget } = await import('../js/modules/budgets.js');

beforeEach(async () => { closeModal(); document.body.innerHTML = '<div id="mount"></div>'; await resetDb(); });

/* ---------------- index-based ledger queries ---------------- */
test('getRecentTransactions: newest first, honours the limit (cursor, not full scan)', async () => {
  const a = await bank('A', 100);
  for (let i = 1; i <= 5; i++) await createExpense({ accountId: a.id, amount: i, category: 'Groceries', date: new Date(2030, 0, i, 12).toISOString() });
  const recent = await L.getRecentTransactions(3);
  assert.deepEqual(recent.map((t) => t.amount), [5, 4, 3]);
});

test('getLedgerBetween: half-open [from, to) range via the date index', async () => {
  const a = await bank('A', 100);
  for (const d of [30, 31]) await createExpense({ accountId: a.id, amount: d, category: 'Groceries', date: new Date(2026, 0, d, 12).toISOString() });
  await createExpense({ accountId: a.id, amount: 1, category: 'Groceries', date: new Date(2026, 1, 1, 12).toISOString() });
  const jan = await L.getLedgerBetween(new Date(2026, 0, 1).toISOString(), new Date(2026, 1, 1).toISOString());
  assert.deepEqual(jan.filter((t) => t.type === 'expense').map((t) => t.amount).sort(), [30, 31]);
});

/* ---------------- dashboard ---------------- */
test('dashboard: month totals use only this month, reversals cancel, budget health + hero render', async () => {
  const a = await bank('Main', 10000);
  const now = new Date();
  await createIncome({ accountId: a.id, amount: 5000, category: 'Salary' });
  const e = await createExpense({ accountId: a.id, amount: 800, category: 'Food & Dining' });
  await L.reverseTransaction(e.id);
  await createExpense({ accountId: a.id, amount: 300, category: 'Food & Dining' });
  await createExpense({ accountId: a.id, amount: 999, category: 'Food & Dining', date: new Date(now.getFullYear() - 1, 5, 5, 12).toISOString() }); // last year: excluded
  await setBudget({ category: 'Food & Dining', monthlyLimit: 1000 });
  await (await import('../js/modules/preferences.js')).setModuleEnabled('budgets', true);   // optional modules start OFF

  const mount = document.querySelector('#mount');
  await renderDashboard(mount);
  const text = mount.textContent;
  assert.match(text, /Net Worth/);
  assert.ok(mount.querySelector('.net-worth-hero'));
  assert.match(text, /Budget Health/);
  assert.match(text, /30% used/);                                  // 300 of 1000 — the reversed 800 and last year's 999 are not counted
  const bar = mount.querySelector('.budget-health-bar');
  assert.equal(bar.getAttribute('role'), 'progressbar');
  assert.equal(bar.getAttribute('aria-valuenow'), '30');
});

test('sparkline: valid svg, handles flat series', () => {
  assert.match(sparkline([1, 2, 3]), /<polyline/);
  assert.doesNotMatch(sparkline([5, 5, 5]), /NaN/);
});

/* ---------------- inline modal errors ---------------- */
test('toast.error appears INSIDE an open dialog (role=alert) and clears on the next click', async () => {
  let attempts = 0;
  openModal({ title: 'Pay', bodyHtml: '', actions: [{ label: 'Go', onClick: () => { attempts++; if (attempts === 1) toast.error('Amount is too large.'); } }] });
  const btn = document.querySelector('.modal-footer button');
  btn.click(); await new Promise((r) => setTimeout(r, 5));
  const box = document.querySelector('.modal-error');
  assert.equal(box.hidden, false);
  assert.equal(box.textContent, 'Amount is too large.');
  assert.equal(box.getAttribute('role'), 'alert');
  assert.equal(document.querySelectorAll('.toast').length, 0, 'no corner toast while a dialog is open');
  btn.click(); await new Promise((r) => setTimeout(r, 5));
  assert.equal(box.hidden, true);
});

test('toast.error with no dialog open still uses a normal toast; showModalError reports false', () => {
  assert.equal(showModalError('x'), false);
  toast.error('Boom');
  assert.equal(document.querySelectorAll('.toast').length, 1);
});

/* ---------------- negative balance + error names ---------------- */
test('spending beyond the balance raises a finora:insufficient-balance event', async () => {
  const a = await bank('Tiny', 100);
  let heard = null;
  window.addEventListener('finora:insufficient-balance', (e) => { heard = e.detail; });
  const t = await createExpense({ accountId: a.id, amount: 250, category: 'Shopping' });
  assert.equal(t.status, 'insufficient_balance');
  assert.equal(heard.id, t.id);
  assert.equal(await balanceOf(a.id), -150);
});

test('error classes carry their own name', async () => {
  await assert.rejects(() => createExpense({ accountId: 'nope', amount: 1, category: 'Groceries' }), (e) => e.name === 'ValidationError');
});

/* ---------------- CSV exports ---------------- */
test('CSV: accounts, loans (installment schedule), people and goals', async () => {
  const a = await bank('HDFC', 1000);
  const raj = await People.createPerson({ name: 'Raj' });
  await People.lendToPerson(raj.id, { accountId: a.id, amount: 200 });
  const g = await Savings.createGoal({ name: 'Trip', targetAmount: 5000 });
  await Loans.createLoan({ name: 'Bike', principal: 1200, interestRate: 0, tenureMonths: 3, emiAmount: 400, startDate: new Date(2026, 0, 31, 12).toISOString() });

  const acc = await B.buildListCsv('accounts');
  assert.match(acc, /Name,Type,Balance/); assert.match(acc, /HDFC,bank,800/);
  const loans = await B.buildListCsv('loans');
  assert.equal(loans.trim().split('\n').length, 1 + 3);
  assert.match(loans, /Bike,1,2026-02-28,400/);                   // local dates, clamped month-end
  assert.match(await B.buildListCsv('people'), /Raj,.*200/);
  assert.match(await B.buildListCsv('goals'), /Trip,5000,0/);
  await assert.rejects(() => B.buildListCsv('nope'), /Unknown export/);
});

test('CSV: transaction export uses the LOCAL date (not UTC)', async () => {
  const a = await bank('A', 100);
  await createExpense({ accountId: a.id, amount: 5, category: 'Groceries', date: new Date(2026, 9, 4, 1, 30).toISOString() }); // 1:30 AM IST on the 4th
  let blobText = '';
  globalThis.document = { createElement: () => ({ click() {}, remove() {}, style: {}, set href(v) {}, set download(v) {} }), body: { appendChild() {}, removeChild() {} } };
  globalThis.URL.createObjectURL = (b) => { blobText = b; return 'blob:x'; }; globalThis.URL.revokeObjectURL = () => {};
  await B.exportCsv('expenses');
  assert.match(await blobText.text(), /2026-10-04/);
  globalThis.document = dom.window.document;
});

/* ---------------- committee foreman commission ---------------- */
test('committee: commission is taken out of the bid before the dividend is shared', async () => {
  const a = await bank('B', 100000);
  const c = await Committees.createCommittee({ name: 'Chit', totalAmount: 100000, numberOfMembers: 10, userMemberships: 1, startDate: new Date().toISOString(), commissionPercent: 5 });
  const [cy] = await Committees.getCycles(c.id);
  const r = await Committees.recordCycle(c.id, cy.id, { winningBid: 20000, userWon: false, paymentAccountId: a.id });
  // commission 5% of 100000 = 5000; dividend = (20000 - 5000)/10 = 1500 per member; payable = 10000 - 1500
  assert.equal(await balanceOf(a.id), 100000 - 8500);
  const cycle = await getById('committee_cycles', cy.id);
  assert.equal(cycle.discountPerMembership, 1500);
});

test('committee: default (0%) behaves exactly as before; bid below commission is rejected', async () => {
  const a = await bank('B', 100000);
  const plain = await Committees.createCommittee({ name: 'Plain', totalAmount: 10000, numberOfMembers: 10, userMemberships: 1, startDate: new Date().toISOString() });
  const [c1] = await Committees.getCycles(plain.id);
  await Committees.recordCycle(plain.id, c1.id, { winningBid: 1000, userWon: false, paymentAccountId: a.id });
  assert.equal(await balanceOf(a.id), 100000 - 900);

  const chit = await Committees.createCommittee({ name: 'Chit', totalAmount: 100000, numberOfMembers: 10, userMemberships: 1, startDate: new Date().toISOString(), commissionPercent: 5 });
  const [c2] = await Committees.getCycles(chit.id);
  await assert.rejects(() => Committees.recordCycle(chit.id, c2.id, { winningBid: 3000, userWon: false, paymentAccountId: a.id }), /at least the foreman's commission/);
  await assert.rejects(() => Committees.createCommittee({ name: 'X', totalAmount: 1000, numberOfMembers: 2, userMemberships: 1, commissionPercent: 50 }), /between 0% and 20%/);
});
