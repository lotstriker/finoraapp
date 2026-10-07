// ==========================================================================
// Finora — modules/recurring.js
// Locked rule (17 - Recurring): a rule is only an expectation. Finora never
// posts a ledger transaction on its own — the user must explicitly choose
// "Record Payment" each time. This file never calls createTransaction
// except from recordPayment(), which is always a direct user action.
// ==========================================================================

import { withTransaction, reqToPromise, getAll, getById } from '../core/db.js';
import { createTransaction, reverseTransaction, ValidationError } from '../core/ledger.js';
import { newId } from '../core/ids.js';
import { addMonthsClamped } from '../utils/date.js';

/** Advances a date according to the rule's frequency mode. */
export function computeNextDate(fromDateIso, rule) {
  if (rule.frequencyMode === 'validity') {
    const d = new Date(fromDateIso);
    d.setDate(d.getDate() + Number(rule.intervalDays || 0));
    return d.toISOString();
  }
  switch (rule.frequency) {
    case 'daily': { const d = new Date(fromDateIso); d.setDate(d.getDate() + 1); return d.toISOString(); }
    case 'weekly': { const d = new Date(fromDateIso); d.setDate(d.getDate() + 7); return d.toISOString(); }
    case 'yearly': return addMonthsClamped(fromDateIso, 12, rule.anchorDay).toISOString();
    case 'monthly':
    default: return addMonthsClamped(fromDateIso, 1, rule.anchorDay).toISOString();
  }
}

/** Exact inverse of computeNextDate — rolls a date back by one interval. */
export function computePreviousDate(fromDateIso, rule) {
  if (rule.frequencyMode === 'validity') {
    const d = new Date(fromDateIso);
    d.setDate(d.getDate() - Number(rule.intervalDays || 0));
    return d.toISOString();
  }
  switch (rule.frequency) {
    case 'daily': { const d = new Date(fromDateIso); d.setDate(d.getDate() - 1); return d.toISOString(); }
    case 'weekly': { const d = new Date(fromDateIso); d.setDate(d.getDate() - 7); return d.toISOString(); }
    case 'yearly': return addMonthsClamped(fromDateIso, -12, rule.anchorDay).toISOString();
    case 'monthly':
    default: return addMonthsClamped(fromDateIso, -1, rule.anchorDay).toISOString();
  }
}

export async function getRules({ includeInactive = true } = {}) {
  const all = await getAll('recurring_rules');
  const filtered = includeInactive ? all : all.filter((r) => r.active);
  return filtered.sort((a, b) => new Date(a.nextDueDate) - new Date(b.nextDueDate));
}

export async function getRuleById(id) {
  return getById('recurring_rules', id);
}

/** Rules due today or overdue. */
export async function getDueRules() {
  const rules = await getRules({ includeInactive: false });
  const now = new Date();
  return rules.filter((r) => new Date(r.nextDueDate) <= now);
}

/** Rules due within the next N days (not yet overdue). */
export async function getUpcomingRules(daysAhead = 7) {
  const rules = await getRules({ includeInactive: false });
  const now = new Date();
  const horizon = new Date(now.getTime() + daysAhead * 86400000);
  return rules.filter((r) => new Date(r.nextDueDate) > now && new Date(r.nextDueDate) <= horizon);
}

/**
 * @param {object} input
 * @param {string} input.name
 * @param {'income'|'expense'} input.type
 * @param {number} input.amount
 * @param {string} input.accountId
 * @param {string} [input.category]
 * @param {'calendar'|'validity'} input.frequencyMode
 * @param {'daily'|'weekly'|'monthly'|'yearly'} [input.frequency] required if frequencyMode === 'calendar'
 * @param {number} [input.intervalDays] required if frequencyMode === 'validity'
 * @param {string} input.startDate ISO date — the first due date
 */
export async function createRule(input) {
  if (!input.name?.trim()) throw new ValidationError('Name is required.');
  if (!['income', 'expense'].includes(input.type)) throw new ValidationError('Select income or expense.');
  if (!(Number(input.amount) > 0)) throw new ValidationError('Amount must be greater than ₹0.');
  if (!input.accountId) throw new ValidationError('Select an account.');
  if (input.frequencyMode === 'validity' && !(Number(input.intervalDays) > 0)) {
    throw new ValidationError('Validity period (days) must be greater than 0.');
  }

  const rule = {
    id: newId('rec'),
    name: input.name.trim(),
    type: input.type,
    amount: Number(input.amount),
    accountId: input.accountId,
    category: input.category || null,
    frequencyMode: input.frequencyMode === 'validity' ? 'validity' : 'calendar',
    frequency: input.frequency || 'monthly',
    intervalDays: input.frequencyMode === 'validity' ? Number(input.intervalDays) : null,
    nextDueDate: input.startDate || new Date().toISOString(),
    // Day-of-month the user intended (e.g. 31). Month-end clamping never forgets it.
    anchorDay: new Date(input.startDate || Date.now()).getDate(),
    lastPaidDate: null,
    lastPaidTransactionId: null,
    active: true,
    createdAt: new Date().toISOString(),
  };

  await withTransaction(['recurring_rules'], 'readwrite', (tx) => {
    tx.objectStore('recurring_rules').put(rule);
  });
  return rule;
}

/**
 * The only place a recurring rule turns into a real transaction — always a
 * direct, explicit user action (never automatic).
 */
export async function recordPayment(ruleId, { accountId, amount, date } = {}) {
  const rule = await getRuleById(ruleId);
  if (!rule) throw new ValidationError('Recurring rule not found.');

  const paidAmount = Number(amount) || rule.amount;
  const paidAccountId = accountId || rule.accountId;
  const paidDate = date || new Date().toISOString();

  return createTransaction({
    type: rule.type,
    direction: rule.type === 'income' ? 'in' : 'out',
    accountId: paidAccountId,
    amount: paidAmount,
    category: rule.category,
    module: 'recurring',
    moduleRef: ruleId,
    description: rule.name,
    date: paidDate,
  }, {
    extraStores: ['recurring_rules'],
    sideEffect: async (tx, record) => {
      const store = tx.objectStore('recurring_rules');
      const r = await reqToPromise(store.get(ruleId));
      r.lastPaidDate = record.date;
      r.lastPaidTransactionId = record.id;
      // Calendar rules ("rent due on the 5th") advance from the DUE date, so paying
      // late/early never shifts the schedule. Validity rules ("28-day recharge")
      // really do restart from the day you paid.
      r.nextDueDate = computeNextDate(r.frequencyMode === 'validity' ? record.date : r.nextDueDate, r);
      store.put(r);
    },
  });
}

/** Advances the due date without recording a payment (e.g. skipped this cycle). */
export async function skipOccurrence(ruleId) {
  return withTransaction(['recurring_rules'], 'readwrite', async (tx) => {
    const store = tx.objectStore('recurring_rules');
    const rule = await reqToPromise(store.get(ruleId));
    if (!rule) throw new ValidationError('Recurring rule not found.');
    rule.nextDueDate = computeNextDate(rule.nextDueDate, rule);
    store.put(rule);
    return rule;
  });
}

export async function setRuleActive(ruleId, active) {
  return withTransaction(['recurring_rules'], 'readwrite', async (tx) => {
    const store = tx.objectStore('recurring_rules');
    const rule = await reqToPromise(store.get(ruleId));
    if (!rule) throw new ValidationError('Recurring rule not found.');
    rule.active = active;
    store.put(rule);
    return rule;
  });
}

/** Deletes the rule itself — its ledger history (already-recorded payments) is untouched. */
export async function deleteRule(ruleId) {
  return withTransaction(['recurring_rules'], 'readwrite', (tx) => {
    tx.objectStore('recurring_rules').delete(ruleId);
  });
}

/**
 * Reverses a recorded recurring payment: undoes the ledger effect AND
 * rewinds nextDueDate back by exactly one interval, AND restores
 * lastPaidDate/lastPaidTransactionId to whatever the most recent OTHER
 * payment for this rule was (or null, if this was the only one).
 * Generic ledger reversal alone left the rule's due-date state untouched.
 */
export async function reverseRecurringPayment(transactionId, reason = '') {
  const original = await getById('ledger', transactionId);
  if (!original) throw new ValidationError('Transaction not found.');
  if (original.module !== 'recurring') throw new ValidationError('This is not a recurring payment.');
  const ruleId = original.moduleRef;

  await reverseTransaction(transactionId, reason, {
    extraStores: ['recurring_rules'],
    sideEffect: async (tx) => {
      const store = tx.objectStore('recurring_rules');
      const rule = await reqToPromise(store.get(ruleId));
      if (!rule) return;

      rule.nextDueDate = computePreviousDate(rule.nextDueDate, rule);

      const allForModule = await reqToPromise(tx.objectStore('ledger').index('module').getAll('recurring'));
      const remaining = allForModule
        .filter((t) => t.moduleRef === ruleId && t.id !== transactionId && !t.parentTransactionId)
        .sort((a, b) => new Date(b.date) - new Date(a.date));

      if (remaining.length > 0) {
        rule.lastPaidDate = remaining[0].date;
        rule.lastPaidTransactionId = remaining[0].id;
      } else {
        rule.lastPaidDate = null;
        rule.lastPaidTransactionId = null;
      }
      store.put(rule);
    },
  });
}
