import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, bank, balanceOf, getById } from './helpers.mjs';

import * as Rec from '../js/modules/recurring.js';
import * as Loans from '../js/modules/loans.js';
import { getDebtPayoffPlan } from '../js/modules/debt-planner.js';
import { addMonthsClamped } from '../js/utils/date.js';

beforeEach(resetDb);
const ymd = (iso) => new Date(iso).toLocaleDateString('en-CA');
const local = (y, m, d) => new Date(y, m - 1, d, 12).toISOString();

/* ---------------- recurring ---------------- */
test('recurring: month-end rules do NOT drift (31 Jan -> 28 Feb -> 31 Mar ...)', () => {
  const rule = { frequencyMode: 'calendar', frequency: 'monthly', anchorDay: 31 };
  let d = local(2027, 1, 31);
  const seq = [ymd(d)];
  for (let i = 0; i < 5; i++) { d = Rec.computeNextDate(d, rule); seq.push(ymd(d)); }
  assert.deepEqual(seq, ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30']);
  // leap year + yearly
  assert.equal(ymd(addMonthsClamped(local(2028, 2, 29), 12, 29)), '2029-02-28');
  assert.equal(ymd(addMonthsClamped(local(2029, 2, 28), 12, 29)), '2030-02-28');
  assert.equal(ymd(addMonthsClamped(local(2031, 2, 28), 12, 29)), '2032-02-29');
});

test('recurring: computePreviousDate is the exact inverse, even across short months', () => {
  const rule = { frequencyMode: 'calendar', frequency: 'monthly', anchorDay: 31 };
  for (const [y, m] of [[2027, 1], [2027, 2], [2027, 3], [2027, 4]]) {
    const due = local(y, m, m === 2 ? 28 : m === 4 ? 30 : 31);
    assert.equal(ymd(Rec.computePreviousDate(Rec.computeNextDate(due, rule), rule)), ymd(due));
  }
});

test('recurring: createRule remembers the anchor day', async () => {
  const a = await bank();
  const r = await Rec.createRule({ name: 'Rent', type: 'expense', amount: 100, accountId: a.id, category: 'Bills & Utilities',
    frequencyMode: 'calendar', frequency: 'monthly', startDate: local(2027, 1, 31) });
  assert.equal(r.anchorDay, 31);
});

test('recurring: paying LATE or EARLY does not shift a calendar schedule', async () => {
  const a = await bank('B', 100000);
  const r = await Rec.createRule({ name: 'Rent', type: 'expense', amount: 100, accountId: a.id, category: 'Bills & Utilities',
    frequencyMode: 'calendar', frequency: 'monthly', startDate: local(2027, 1, 5) });
  await Rec.recordPayment(r.id, { date: local(2027, 1, 12) });           // 7 days late
  assert.equal(ymd((await Rec.getRuleById(r.id)).nextDueDate), '2027-02-05');
  await Rec.recordPayment(r.id, { date: local(2027, 1, 30) });           // early
  assert.equal(ymd((await Rec.getRuleById(r.id)).nextDueDate), '2027-03-05');
});

test('recurring: validity rules (e.g. 28-day recharge) restart from the payment day', async () => {
  const a = await bank('B', 100000);
  const r = await Rec.createRule({ name: 'Recharge', type: 'expense', amount: 100, accountId: a.id, category: 'Bills & Utilities',
    frequencyMode: 'validity', intervalDays: 28, startDate: local(2027, 1, 1) });
  await Rec.recordPayment(r.id, { date: local(2027, 1, 10) });
  assert.equal(ymd((await Rec.getRuleById(r.id)).nextDueDate), '2027-02-07');
});

test('recurring: reversing a payment restores the previous due date exactly', async () => {
  const a = await bank('B', 100000);
  const r = await Rec.createRule({ name: 'Rent', type: 'expense', amount: 100, accountId: a.id, category: 'Bills & Utilities',
    frequencyMode: 'calendar', frequency: 'monthly', startDate: local(2027, 1, 31) });
  const t = await Rec.recordPayment(r.id, { date: local(2027, 2, 3) });
  assert.equal(ymd((await Rec.getRuleById(r.id)).nextDueDate), '2027-02-28');
  await Rec.reverseRecurringPayment(t.id);
  assert.equal(ymd((await Rec.getRuleById(r.id)).nextDueDate), '2027-01-31');
  assert.equal(await balanceOf(a.id), 100000);
});

/* ---------------- loans / net worth ---------------- */
test('loanProgress: remainingPrincipal excludes future interest', async () => {
  const loan = await Loans.createLoan({ name: 'L', principal: 12000, interestRate: 12, tenureMonths: 12, emiAmount: 1066.19, startDate: new Date().toISOString() });
  const insts = await Loans.getInstallments(loan.id);
  const p0 = Loans.loanProgress(insts);
  assert.ok(Math.abs(p0.remainingPrincipal - 12000) < 1, `principal ${p0.remainingPrincipal}`);
  assert.ok(p0.remainingAmount > p0.remainingPrincipal + 500, 'total-to-pay includes interest, principal does not');
  const a = await bank('B', 50000);
  await Loans.payInstallment(loan.id, insts[0].id, { accountId: a.id });
  const p1 = Loans.loanProgress(await Loans.getInstallments(loan.id));
  assert.ok(Math.abs(p1.remainingPrincipal - (12000 - insts[0].principalComponent)) < 0.02);
});

/* ---------------- debt planner ---------------- */
test('debt planner: freed EMIs ROLL OVER into the next loan (0% hand-checkable case)', async () => {
  // A: 1000 @ 500/mo (2 months). B: 3000 @ 500/mo (6 months). Budget = 1000/mo.
  await Loans.createLoan({ name: 'A', principal: 1000, interestRate: 0, tenureMonths: 2, emiAmount: 500, startDate: new Date().toISOString() });
  await Loans.createLoan({ name: 'B', principal: 3000, interestRate: 0, tenureMonths: 6, emiAmount: 500, startDate: new Date().toISOString() });
  const plan = await getDebtPayoffPlan('snowball', 0);
  assert.equal(plan.baselineMonths, 6);       // minimums only: B takes 6 months
  assert.equal(plan.planMonths, 4);           // A done in 2; then A's 500 rolls into B: 2000 left / 1000 = 2 more
  assert.equal(plan.monthsSaved, 2);
  assert.equal(plan.order[0].name, 'A');
  assert.equal(plan.order[0].payoffMonth, 2);
  assert.equal(plan.order[1].payoffMonth, 4);
  assert.equal(plan.planCompletes, true);
});

test('debt planner: extra payment cascades mid-month to the next loan', async () => {
  await Loans.createLoan({ name: 'A', principal: 1000, interestRate: 0, tenureMonths: 10, emiAmount: 100, startDate: new Date().toISOString() });
  await Loans.createLoan({ name: 'B', principal: 3000, interestRate: 0, tenureMonths: 10, emiAmount: 300, startDate: new Date().toISOString() });
  // budget = 400 + 2000 extra = 2400/mo. Month 1: A needs 1000, B 3000 -> A cleared (1000), 1400 left to B -> B has 1600 left.
  // Month 2: B cleared. Total 2 months.
  const plan = await getDebtPayoffPlan('snowball', 2000);
  assert.equal(plan.planMonths, 2);
  assert.equal(plan.order[0].payoffMonth, 1);
  assert.equal(plan.order[1].payoffMonth, 2);
});

test('debt planner: total interest ordering — avalanche <= snowball <= minimums-only', async () => {
  await Loans.createLoan({ name: 'Card', principal: 50000, interestRate: 24, tenureMonths: 12, emiAmount: 4728, startDate: new Date().toISOString() });
  await Loans.createLoan({ name: 'Car', principal: 20000, interestRate: 8, tenureMonths: 12, emiAmount: 1740, startDate: new Date().toISOString() });
  const av = await getDebtPayoffPlan('avalanche', 3000);
  const sn = await getDebtPayoffPlan('snowball', 3000);
  assert.equal(av.order[0].name, 'Card');                 // highest rate first
  assert.equal(sn.order[0].name, 'Car');                  // smallest balance first
  assert.ok(av.planInterest <= sn.planInterest, `${av.planInterest} <= ${sn.planInterest}`);
  assert.ok(sn.planInterest <= sn.baselineInterest);
  assert.ok(av.planMonths < av.baselineMonths);
});

test('debt planner: a minimum that never covers interest is flagged, not shown as "0 months"', async () => {
  await Loans.createLoan({ name: 'Trap', principal: 100000, interestRate: 36, tenureMonths: 12, emiAmount: 1000, startDate: new Date().toISOString() });
  const plan = await getDebtPayoffPlan('avalanche', 0);
  assert.equal(plan.baselineStuck, true);
  const fixed = await getDebtPayoffPlan('avalanche', 20000);
  assert.equal(fixed.planCompletes, true);
});

test('net worth history: loan counts as PRINCIPAL owed, not principal + future interest', async () => {
  const { getNetWorthHistory } = await import('../js/modules/insights.js');
  await bank('Cash', 1000);
  await Loans.createLoan({ name: 'L', principal: 12000, interestRate: 12, tenureMonths: 12, emiAmount: 1066.19, startDate: new Date(2020, 0, 1).toISOString() });
  const pts = await getNetWorthHistory(2);
  const last = pts[pts.length - 1].netWorth;
  assert.ok(Math.abs(last - (1000 - 12000)) < 1, `net worth ${last} should be ~ -11000, not ~ -${(1066.19 * 12 - 1000).toFixed(0)}`);
});
