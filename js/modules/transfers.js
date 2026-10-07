// ==========================================================================
// Finora — modules/transfers.js
// ==========================================================================

import { createTransaction, ValidationError } from '../core/ledger.js';
import { getAll } from '../core/db.js';

/**
 * @param {object} input
 * @param {string} input.fromAccountId
 * @param {string} input.toAccountId
 * @param {number} input.amount
 * @param {string} [input.description]
 * @param {string} [input.date]
 */
export async function createTransfer(input, opts = {}) {
  if (input.fromAccountId === input.toAccountId) {
    throw new ValidationError('From and To accounts must be different.');
  }
  return createTransaction({
    type: 'transfer',
    direction: 'transfer',
    accountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amount: input.amount,
    module: 'transfers',
    description: input.description || 'Transfer',
    date: input.date,
  }, opts);
}

/** All transfer entries, newest first. */
export async function getTransferEntries() {
  const all = await getAll('ledger');
  return all
    .filter((t) => t.type === 'transfer')
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}
