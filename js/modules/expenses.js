// ==========================================================================
// Finora — modules/expenses.js
// ==========================================================================

import { createTransaction, ValidationError } from '../core/ledger.js';
import { getAll, getById } from '../core/db.js';
import { getCategories } from './categories.js';

/**
 * @param {object} input
 * @param {string} input.accountId account the expense was paid from
 * @param {number} input.amount
 * @param {string} input.category
 * @param {string} [input.description]
 * @param {string[]} [input.tags]
 * @param {string} [input.date]
 */
/**
 * @param {object} input
 * @param {string} input.accountId account the expense was paid from
 * @param {number} input.amount
 * @param {string} input.category
 * @param {string} [input.description]
 * @param {string[]} [input.tags]
 * @param {string} [input.date]
 * @param {object} [input.attachment]
 */
export async function createExpense(input, opts = {}) {
  if (!input.category) throw new ValidationError('Expense category is required.');
  const valid = await getCategories('expense');
  if (!valid.some((c) => c.name === input.category)) {
    throw new ValidationError('Select a valid expense category.');
  }
  return createTransaction({
    type: 'expense',
    direction: 'out',
    accountId: input.accountId,
    amount: input.amount,
    category: input.category,
    module: 'expenses',
    description: input.description || input.category || 'Expense',
    tags: input.tags || [],
    attachment: input.attachment,
    date: input.date,
  }, opts);
}

/** All expense entries, newest first. */
export async function getExpenseEntries() {
  const all = await getAll('ledger');
  return all
    .filter((t) => t.type === 'expense')
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

/**
 * Records a refund against a specific expense — money coming back in,
 * linked to the original so Reports can net it against that expense
 * rather than counting it as fresh income.
 * @param {string} originalExpenseTransactionId
 * @param {object} input
 * @param {string} input.accountId account the refund lands in
 * @param {number} input.amount
 * @param {string} [input.description]
 * @param {string} [input.date]
 */
export async function recordRefund(originalExpenseTransactionId, input) {
  const original = await getById('ledger', originalExpenseTransactionId);
  if (!original) throw new ValidationError('Original expense not found.');
  if (original.type !== 'expense') throw new ValidationError('Refunds can only be recorded against an expense.');

  const priorRefunds = await getRefundsFor(originalExpenseTransactionId);
  const alreadyRefunded = priorRefunds.reduce((s, r) => s + r.amount, 0);
  const remaining = original.amount - alreadyRefunded;
  if (Number(input.amount) > remaining) {
    throw new ValidationError(`Refund cannot exceed the remaining refundable amount of ${remaining}.`);
  }

  return createTransaction({
    type: 'refund',
    direction: 'in',
    accountId: input.accountId,
    amount: input.amount,
    category: original.category,
    module: 'expenses',
    moduleRef: originalExpenseTransactionId,
    description: input.description || `Refund — ${original.description || 'Expense'}`,
    date: input.date,
  });
}

/** All refund entries linked to a specific expense transaction. */
export async function getRefundsFor(expenseTransactionId) {
  const all = await getAll('ledger');
  return all.filter((t) => t.type === 'refund' && t.moduleRef === expenseTransactionId);
}
