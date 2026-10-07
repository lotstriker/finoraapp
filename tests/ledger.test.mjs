import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, bank, balanceOf, totalMoney, getAll, getById } from './helpers.mjs';

import { createAccount } from '../js/modules/accounts.js';
import { createExpense, recordRefund } from '../js/modules/expenses.js';
import { createIncome } from '../js/modules/income.js';
import { createTransfer } from '../js/modules/transfers.js';
import { reverseTransaction } from '../js/core/ledger.js';
import { signedExpense, signedIncome } from '../js/utils/ledger-math.js';
import { setBudget, getBudgetProgress } from '../js/modules/budgets.js';
import { parseTransactionId } from '../js/core/ids.js';

beforeEach(resetDb);

test('ledger ids are unique and parseable (device suffix)', async () => {
  const a = await bank();
  const e1 = await createExpense({ accountId: a.id, amount: 10, category: 'Groceries' });
  const e2 = await createExpense({ accountId: a.id, amount: 10, category: 'Groceries' });
  assert.notEqual(e1.id, e2.id);
  assert.ok(parseTransactionId(e1.id), e1.id);
  assert.equal(parseTransactionId('TXN-2026-000184').seq, 184); // legacy format still parses
});

test('REVERSED expense cancels out of expense totals (was: doubled)', async () => {
  const a = await bank();
  const e = await createExpense({ accountId: a.id, amount: 500, category: 'Food & Dining' });
  await reverseTransaction(e.id, 'mistake');
  const ledger = await getAll('ledger');
  assert.equal(ledger.reduce((s, t) => s + signedExpense(t), 0), 0);
  assert.equal(await balanceOf(a.id), 10000);
});

test('budget frees up again after a reversal or refund', async () => {
  const a = await bank();
  await setBudget({ category: 'Food & Dining', monthlyLimit: 1000 });
  const e = await createExpense({ accountId: a.id, amount: 800, category: 'Food & Dining' });
  assert.equal((await getBudgetProgress())[0].spent, 800);
  await recordRefund(e.id, { accountId: a.id, amount: 300 });
  assert.equal((await getBudgetProgress())[0].spent, 500);
  const e2 = await createExpense({ accountId: a.id, amount: 100, category: 'Food & Dining' });
  await reverseTransaction(e2.id);
  assert.equal((await getBudgetProgress())[0].spent, 500);
});

test('reversed income cancels out of income totals', async () => {
  const a = await bank('B', 0.01);
  const i = await createIncome({ accountId: a.id, amount: 2000, category: 'Salary' });
  await reverseTransaction(i.id);
  const ledger = await getAll('ledger');
  assert.equal(ledger.reduce((s, t) => s + signedIncome(t), 0), 0);
});

test('a transaction can only be reversed ONCE, even with concurrent clicks', async () => {
  const a = await bank();
  const e = await createExpense({ accountId: a.id, amount: 700, category: 'Food & Dining' });
  const r = await Promise.allSettled([reverseTransaction(e.id, 'a'), reverseTransaction(e.id, 'b')]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(await balanceOf(a.id), 10000);
});

test('reversing a reversal is rejected', async () => {
  const a = await bank();
  const e = await createExpense({ accountId: a.id, amount: 50, category: 'Groceries' });
  const rev = await reverseTransaction(e.id);
  await assert.rejects(() => reverseTransaction(rev.id), /itself a reversal/);
});

test('credit card OVERPAYMENT keeps money conserved (becomes a credit balance)', async () => {
  const b = await bank();
  const card = await createAccount({ name: 'Card', type: 'credit_card', creditLimit: 50000 });
  await createExpense({ accountId: card.id, amount: 1000, category: 'Shopping' });
  const before = await totalMoney();                         // 10000 - 1000
  await createTransfer({ fromAccountId: b.id, toAccountId: card.id, amount: 5000 });
  assert.equal(await totalMoney(), before);                  // nothing vanished
  const c = await getById('accounts', card.id);
  assert.equal(c.usedAmount, -4000);                         // 4000 credit on the card
});

test('credit limit is still a hard block', async () => {
  const card = await createAccount({ name: 'Card', type: 'credit_card', creditLimit: 1000 });
  await assert.rejects(() => createExpense({ accountId: card.id, amount: 1500, category: 'Shopping' }), /limit/);
});
