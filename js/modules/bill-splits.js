// ==========================================================================
// Finora — modules/bill-splits.js
// Bill Splitting: you pay the full amount, participants each owe their
// share. Rather than inventing a separate debt system, this posts one
// real expense (the full amount, from your account) plus one People
// "lend" entry per participant for their share — so settling up, balance
// tracking, and Overdue badges all reuse the existing People module.
// The bill_splits record is purely a grouping/display layer over those
// underlying transactions.
// ==========================================================================

import { getAll, getById, withTransaction, reqToPromise } from '../core/db.js';
import { getCategories } from './categories.js';
import { ValidationError, postLinkedTransaction, postLinkedReversal, getLedgerForPerson } from '../core/ledger.js';
import { roundMoney } from '../utils/currency.js';

function newId() {
  return `spl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function getBillSplits() {
  const all = await getAll('bill_splits');
  return all.sort((a, b) => new Date(b.date) - new Date(a.date));
}

export async function getBillSplitById(id) {
  return getById('bill_splits', id);
}

/**
 * @param {object} input
 * @param {string} input.description
 * @param {string} input.category
 * @param {number} input.totalAmount
 * @param {string} input.accountId account the full amount is paid from
 * @param {string} [input.date]
 * @param {Array<{personId: string, amount: number}>} input.participants everyone who owes a share (excluding yourself)
 * @param {number} [input.yourShare] your own portion, informational only — not owed to anyone
 */
export async function createBillSplit(input) {
  if (!input.description) throw new ValidationError('Give this split a description.');
  if (!(Number(input.totalAmount) > 0)) throw new ValidationError('Total amount must be greater than ₹0.');
  if (!input.accountId) throw new ValidationError('Choose which account paid the full amount.');
  if (!input.participants || input.participants.length === 0) throw new ValidationError('Add at least one other person to split with.');

  const participantsTotal = roundMoney(input.participants.reduce((s, p) => s + p.amount, 0));
  const yourShare = roundMoney(input.totalAmount - participantsTotal);
  if (yourShare < 0) throw new ValidationError('The participant shares add up to more than the total amount.');

  if (yourShare > 0) {
    const valid = await getCategories('expense');
    if (!valid.some((c) => c.name === input.category)) throw new ValidationError('Select a valid expense category.');
  }

  const date = input.date || new Date().toISOString();
  const record = {
    id: newId(),
    description: input.description,
    category: input.category,
    totalAmount: input.totalAmount,
    yourShare,
    accountId: input.accountId,
    date,
    expenseTransactionId: null,
    participants: [],
    createdAt: new Date().toISOString(),
  };

  // EVERYTHING (your expense, each person's lending entry, the grouping
  // record) happens in ONE atomic transaction. Before, these were separate
  // writes: if participant #2 failed, participant #1's lending and your
  // expense were already committed and the money stayed stuck in the books.
  await withTransaction(['ledger', 'accounts', 'settings', 'people', 'bill_splits'], 'readwrite', async (tx) => {
    // 1. Your own share is the only part that's a real expense for you.
    if (yourShare > 0) {
      const exp = await postLinkedTransaction(tx, {
        type: 'expense', direction: 'out', accountId: input.accountId, amount: yourShare,
        category: input.category, module: 'expenses', description: input.description, date,
      });
      record.expenseTransactionId = exp.id;
    }
    // 2. Each participant owes you their share — a normal People lending entry.
    for (const p of input.participants) {
      const lend = await postLinkedTransaction(tx, {
        type: 'person_lending', direction: 'out', accountId: input.accountId, amount: p.amount,
        personId: p.personId, module: 'people', description: `Share of "${input.description}"`, date,
      });
      record.participants.push({ personId: p.personId, amount: p.amount, lendingTransactionId: lend.id, settled: false });
    }
    // 3. Group them for display.
    tx.objectStore('bill_splits').put(record);
  });
  return record;
}

/**
 * Reverses everything a bill split created: the original expense and
 * every participant's lending entry. Already-settled participants
 * (who've since repaid) still get their lending entry reversed —
 * the reversal nets out correctly either way since it's a mirrored
 * opposite-direction entry, not a deletion.
 */
export async function reverseBillSplit(id, reason = 'Bill split reversed') {
  const split = await getBillSplitById(id);
  if (!split) throw new ValidationError('Bill split not found.');

  // Guard: if anyone has made any repayment (linked to this split or not)
  // since their lending was created, reversing on top of that would
  // double-credit the account — once from their real repayment, once
  // from the reversal. This errs conservative: it blocks some reversals
  // that would technically be safe, but never allows the double-credit.
  for (const p of split.participants) {
    const lending = await getById('ledger', p.lendingTransactionId);
    if (!lending) continue;
    const personLedger = await getLedgerForPerson(p.personId);
    const hasRepaymentSince = personLedger.some((t) =>
      t.type === 'person_repayment' && new Date(t.date) >= new Date(lending.date)
    );
    if (hasRepaymentSince) {
      throw new ValidationError('Someone in this split has already made a repayment — reverse or settle that first, then try again.');
    }
  }

  // Reversals AND removal of the grouping record: one atomic transaction.
  await withTransaction(['ledger', 'accounts', 'settings', 'people', 'bill_splits'], 'readwrite', async (tx) => {
    if (split.expenseTransactionId) {
      await postLinkedReversal(tx, split.expenseTransactionId, reason);
    }
    for (const p of split.participants) {
      await postLinkedReversal(tx, p.lendingTransactionId, reason);
    }
    tx.objectStore('bill_splits').delete(id);
  });
}
