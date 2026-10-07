// ==========================================================================
// Finora — modules/income.js
// ==========================================================================

import { createTransaction, ValidationError } from '../core/ledger.js';
import { withTransaction, reqToPromise, getAll } from '../core/db.js';
import { getCategories } from './categories.js';

/**
 * @param {object} input
 * @param {string} input.accountId destination account
 * @param {number} input.amount
 * @param {string} input.category
 * @param {string} [input.source] e.g. "ABC Company", "Upwork" — who/where it came from, separate from category
 * @param {string} [input.description]
 * @param {string[]} [input.tags]
 * @param {string} [input.date]
 * @param {object} [input.attachment]
 */
export async function createIncome(input, opts = {}) {
  if (!input.category) throw new ValidationError('Income category is required.');
  const valid = await getCategories('income');
  if (!valid.some((c) => c.name === input.category)) {
    throw new ValidationError('Select a valid income category.');
  }
  return createTransaction({
    type: 'income',
    direction: 'in',
    accountId: input.accountId,
    amount: input.amount,
    category: input.category,
    source: input.source,
    module: 'income',
    description: input.description || input.category || 'Income',
    tags: input.tags || [],
    attachment: input.attachment,
    date: input.date,
  }, opts);
}

/** All income entries, newest first. */
export async function getIncomeEntries() {
  const all = await getAll('ledger');
  return all
    .filter((t) => t.type === 'income')
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}
