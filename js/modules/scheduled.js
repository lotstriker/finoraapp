// ==========================================================================
// Finora — modules/scheduled.js
// Scheduled (one-time) Future Transactions — e.g. "salary lands on the
// 15th". Unlike Recurring rules, these fire exactly once and never
// repeat. Nothing here touches the ledger until the user explicitly
// records it (or it's marked as skipped) — a scheduled entry is purely a
// plan until then.
// ==========================================================================

import { getAll, getById, withTransaction, reqToPromise } from '../core/db.js';
import { createIncome } from './income.js';
import { createExpense } from './expenses.js';
import { createTransfer } from './transfers.js';
import { ValidationError } from '../core/ledger.js';

function newId() {
  return `sch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** All scheduled transactions, soonest first. Pass includeCompleted to also see history. */
export async function getScheduledTransactions({ includeCompleted = false } = {}) {
  const all = await getAll('scheduled_transactions');
  const filtered = includeCompleted ? all : all.filter((s) => s.status === 'pending');
  return filtered.sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate));
}

export async function getScheduledById(id) {
  return getById('scheduled_transactions', id);
}

/**
 * @param {object} input
 * @param {'income'|'expense'|'transfer'} input.type
 * @param {number} input.amount
 * @param {string} input.scheduledDate
 * @param {string} [input.accountId] required for income/expense; source account for transfer
 * @param {string} [input.toAccountId] required for transfer
 * @param {string} [input.category] required for income/expense
 * @param {string} [input.description]
 */
export async function createScheduled(input) {
  if (!['income', 'expense', 'transfer'].includes(input.type)) throw new ValidationError('Choose a transaction type.');
  if (!(Number(input.amount) > 0)) throw new ValidationError('Amount must be greater than ₹0.');
  if (!input.scheduledDate) throw new ValidationError('Choose a date.');
  if (input.type === 'transfer') {
    if (!input.accountId || !input.toAccountId) throw new ValidationError('Choose both accounts for a transfer.');
    if (input.accountId === input.toAccountId) throw new ValidationError('Choose two different accounts.');
  } else {
    if (!input.accountId) throw new ValidationError('Choose an account.');
    if (!input.category) throw new ValidationError('Choose a category.');
  }

  const record = {
    id: newId(),
    type: input.type,
    amount: Number(input.amount),
    scheduledDate: input.scheduledDate,
    accountId: input.accountId,
    toAccountId: input.toAccountId || null,
    category: input.category || null,
    description: input.description || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  await withTransaction(['scheduled_transactions'], 'readwrite', async (tx) => {
    await reqToPromise(tx.objectStore('scheduled_transactions').put(record));
  });
  return record;
}

/**
 * Posts the actual ledger transaction for a scheduled item and marks it
 * completed. Uses today's date for the real transaction unless the
 * scheduled date is used explicitly via useScheduledDate.
 */
export async function recordScheduled(id, { useScheduledDate = false } = {}) {
  const item = await getScheduledById(id);
  if (!item) throw new ValidationError('Scheduled transaction not found.');
  if (item.status !== 'pending') throw new ValidationError('This has already been recorded or skipped.');

  const date = useScheduledDate ? item.scheduledDate : new Date().toISOString();
  let posted;
  if (item.type === 'income') {
    posted = await createIncome({ accountId: item.accountId, amount: item.amount, category: item.category, description: item.description, date });
  } else if (item.type === 'expense') {
    posted = await createExpense({ accountId: item.accountId, amount: item.amount, category: item.category, description: item.description, date });
  } else {
    posted = await createTransfer({ fromAccountId: item.accountId, toAccountId: item.toAccountId, amount: item.amount, description: item.description, date });
  }

  await withTransaction(['scheduled_transactions'], 'readwrite', async (tx) => {
    await reqToPromise(tx.objectStore('scheduled_transactions').put({ ...item, status: 'completed', completedTransactionId: posted.id }));
  });
  return posted;
}

export async function skipScheduled(id) {
  const item = await getScheduledById(id);
  if (!item) throw new ValidationError('Scheduled transaction not found.');
  await withTransaction(['scheduled_transactions'], 'readwrite', async (tx) => {
    await reqToPromise(tx.objectStore('scheduled_transactions').put({ ...item, status: 'skipped' }));
  });
}

export async function deleteScheduled(id) {
  await withTransaction(['scheduled_transactions'], 'readwrite', async (tx) => {
    await reqToPromise(tx.objectStore('scheduled_transactions').delete(id));
  });
}

/** How many days until due (negative = overdue). */
export function daysUntil(scheduledDate) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(scheduledDate); target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}
