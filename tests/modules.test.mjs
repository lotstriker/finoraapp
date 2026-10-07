import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, bank, balanceOf, getAll, getById, withTransaction } from './helpers.mjs';

import * as Savings from '../js/modules/savings.js';
import * as Loans from '../js/modules/loans.js';
import * as Inv from '../js/modules/investments.js';
import * as Sched from '../js/modules/scheduled.js';
import * as Committees from '../js/modules/committees.js';
import * as Splits from '../js/modules/bill-splits.js';
import * as People from '../js/modules/people.js';

beforeEach(resetDb);
const ok = (rs) => rs.filter((r) => r.status === 'fulfilled').length;

test('EMI: double-click pays ONE installment only', async () => {
  const a = await bank('B', 100000);
  const loan = await Loans.createLoan({ name: 'L', principal: 12000, interestRate: 0, tenureMonths: 12, emiAmount: 1000, startDate: new Date().toISOString() });
  const [i1] = await Loans.getInstallments(loan.id);
  const rs = await Promise.allSettled([
    Loans.payInstallment(loan.id, i1.id, { accountId: a.id }),
    Loans.payInstallment(loan.id, i1.id, { accountId: a.id }),
  ]);
  assert.equal(ok(rs), 1);
  assert.equal(await balanceOf(a.id), 99000);
});

test('Investment: create is atomic; double redeem credits ONCE', async () => {
  const a = await bank('B', 50000);
  const inv = await Inv.createInvestment({ name: 'FD', type: 'fd', investedAmount: 10000, accountId: a.id });
  assert.equal((await getById('investments', inv.id)).investTransactionId.startsWith('TXN-'), true);
  const rs = await Promise.allSettled([
    Inv.redeemInvestment(inv.id, { accountId: a.id, redeemAmount: 10500 }),
    Inv.redeemInvestment(inv.id, { accountId: a.id, redeemAmount: 10500 }),
  ]);
  assert.equal(ok(rs), 1);
  assert.equal(await balanceOf(a.id), 50000 - 10000 + 10500);
  assert.equal((await getById('investments', inv.id)).status, 'redeemed');
});

test('Scheduled: double-click posts ONCE and marks completed atomically', async () => {
  const a = await bank('B', 5000);
  const s = await Sched.createScheduled({ type: 'expense', amount: 300, scheduledDate: '2026-10-05', accountId: a.id, category: 'Food & Dining' });
  const rs = await Promise.allSettled([Sched.recordScheduled(s.id), Sched.recordScheduled(s.id)]);
  assert.equal(ok(rs), 1);
  assert.equal(await balanceOf(a.id), 4700);
  const rec = await getById('scheduled_transactions', s.id);
  assert.equal(rec.status, 'completed');
  assert.ok(rec.completedTransactionId);
});

test('Committee: same cycle cannot be recorded twice concurrently', async () => {
  const a = await bank('B', 100000);
  const c = await Committees.createCommittee({ name: 'C', totalAmount: 10000, numberOfMembers: 10, userMemberships: 1, startDate: new Date().toISOString() });
  const [cy] = await Committees.getCycles(c.id);
  const rs = await Promise.allSettled([
    Committees.recordCycle(c.id, cy.id, { winningBid: 1000, userWon: false, paymentAccountId: a.id }),
    Committees.recordCycle(c.id, cy.id, { winningBid: 1000, userWon: false, paymentAccountId: a.id }),
  ]);
  assert.equal(ok(rs), 1);
  assert.equal(await balanceOf(a.id), 100000 - 900);
});

test('Savings: reversing a contribution that was partly withdrawn is BLOCKED (was: created money)', async () => {
  const a = await bank('B', 100000);
  const g = await Savings.createGoal({ name: 'Trip', targetAmount: 5000 });
  const c1 = await Savings.contribute(g.id, { accountId: a.id, amount: 1000 });
  const w = await Savings.withdraw(g.id, { accountId: a.id, amount: 800 });
  await assert.rejects(() => Savings.reverseContribution(c1.id), /reverse the later withdrawal/);
  // unwind in the right order -> everything balances
  await Savings.reverseContribution(w.id);
  await Savings.reverseContribution(c1.id);
  const goal = await getById('savings_goals', g.id);
  assert.equal(goal.currentAmount, 0);
  assert.equal(await balanceOf(a.id), 100000);
});

test('Savings: withdraw more than held is rejected inside the transaction', async () => {
  const a = await bank();
  const g = await Savings.createGoal({ name: 'G', targetAmount: 100 });
  await Savings.contribute(g.id, { accountId: a.id, amount: 100 });
  const rs = await Promise.allSettled([
    Savings.withdraw(g.id, { accountId: a.id, amount: 100 }),
    Savings.withdraw(g.id, { accountId: a.id, amount: 100 }),
  ]);
  assert.equal(ok(rs), 1);
  assert.equal((await getById('savings_goals', g.id)).currentAmount, 0);
});

test('Bill split: failure rolls EVERYTHING back (was: orphan ledger rows)', async () => {
  const a = await bank('B', 10000);
  const raj = await People.createPerson({ name: 'Raj' });
  await assert.rejects(() => Splits.createBillSplit({
    description: 'Dinner', category: 'Food & Dining', totalAmount: 1000, accountId: a.id,
    participants: [{ personId: raj.id, amount: 300 }, { personId: 'per_missing', amount: 300 }],
  }), /Person not found/);
  assert.equal((await getAll('ledger')).filter((t) => t.type !== 'external_funding').length, 0);
  assert.equal(await balanceOf(a.id), 10000);
  assert.equal((await getById('people', raj.id)).balance, 0);
  assert.equal((await getAll('bill_splits')).length, 0);
});

test('Bill split: success posts your share + lendings, and reverses cleanly', async () => {
  const a = await bank('B', 10000);
  const raj = await People.createPerson({ name: 'Raj' });
  const sam = await People.createPerson({ name: 'Sam' });
  const s = await Splits.createBillSplit({
    description: 'Trip', category: 'Travel', totalAmount: 900, accountId: a.id,
    participants: [{ personId: raj.id, amount: 300 }, { personId: sam.id, amount: 300 }],
  });
  assert.equal(s.yourShare, 300);
  assert.equal(await balanceOf(a.id), 10000 - 900);
  assert.equal((await getById('people', raj.id)).balance, 300);
  await Splits.reverseBillSplit(s.id);
  assert.equal(await balanceOf(a.id), 10000);
  assert.equal((await getById('people', raj.id)).balance, 0);
  assert.equal((await getAll('bill_splits')).length, 0);
});

test('INVARIANT: cached balances always equal what the ledger says', async () => {
  const { createAccount } = await import('../js/modules/accounts.js');
  const { createExpense } = await import('../js/modules/expenses.js');
  const { createTransfer } = await import('../js/modules/transfers.js');
  const { reverseTransaction } = await import('../js/core/ledger.js');
  const { recomputeBalancesInTx } = await import('../js/modules/backup.js');

  const a = await bank('A', 20000);
  const b = await bank('B', 5000);
  const card = await createAccount({ name: 'Card', type: 'credit_card', creditLimit: 50000 });
  const raj = await People.createPerson({ name: 'Raj' });
  const g = await Savings.createGoal({ name: 'G', targetAmount: 9999 });

  const e = await createExpense({ accountId: card.id, amount: 1200, category: 'Shopping' });
  await createTransfer({ fromAccountId: a.id, toAccountId: card.id, amount: 3000 });   // overpays the card
  await createTransfer({ fromAccountId: a.id, toAccountId: b.id, amount: 700 });
  await People.lendToPerson(raj.id, { accountId: a.id, amount: 400 });
  const c = await Savings.contribute(g.id, { accountId: b.id, amount: 900 });
  await Savings.withdraw(g.id, { accountId: b.id, amount: 200 });
  await reverseTransaction(e.id);
  const loan = await Loans.createLoan({ name: 'L', principal: 6000, interestRate: 12, tenureMonths: 6, emiAmount: 1036, startDate: new Date().toISOString() });
  const [i1] = await Loans.getInstallments(loan.id);
  await Loans.payInstallment(loan.id, i1.id, { accountId: a.id });

  const snap = async () => ({
    acc: Object.fromEntries((await getAll('accounts')).map((x) => [x.name, [x.balance, x.usedAmount ?? null]])),
    per: (await getAll('people')).map((x) => x.balance),
    goal: (await getAll('savings_goals')).map((x) => x.currentAmount),
  });
  const live = await snap();
  await withTransaction(['ledger', 'accounts', 'people', 'savings_goals'], 'readwrite', (tx) => recomputeBalancesInTx(tx));
  assert.deepEqual(await snap(), live);
});
