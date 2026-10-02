// ==========================================================================
// Finora — modules/budgets.js
// Monthly Budgets: a per-category spending limit for the current
// calendar month. Budgets don't move money or touch the ledger — they're
// purely a comparison against existing expense transactions, computed
// fresh each time (never stored/cached), so they can never drift out of
// sync with the ledger.
// ==========================================================================

import { getAll, getById, withTransaction, reqToPromise } from '../core/db.js';
import { ValidationError } from '../core/ledger.js';
import { roundMoney } from '../utils/currency.js';

function newId() {
  return `bud_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** All budgets, one per category. */
export async function getBudgets() {
  return getAll('budgets');
}

export async function getBudgetById(id) {
  return getById('budgets', id);
}

/**
 * Creates or updates the budget for a category (one budget per category —
 * setting a new limit for a category that already has one replaces it).
 */
export async function setBudget({ category, monthlyLimit }) {
  if (!category) throw new ValidationError('Choose a category.');
  const limit = Number(monthlyLimit);
  if (!Number.isFinite(limit) || limit <= 0) throw new ValidationError('Enter a monthly limit greater than ₹0.');

  const existing = (await getBudgets()).find((b) => b.category === category);
  const record = {
    id: existing ? existing.id : newId(),
    category,
    monthlyLimit: roundMoney(limit),
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await withTransaction(['budgets'], 'readwrite', async (tx) => {
    await reqToPromise(tx.objectStore('budgets').put(record));
  });
  return record;
}

export async function deleteBudget(id) {
  await withTransaction(['budgets'], 'readwrite', async (tx) => {
    await reqToPromise(tx.objectStore('budgets').delete(id));
  });
}

/**
 * For every budget, computes how much of the current calendar month's
 * limit has been spent, purely from existing expense ledger entries —
 * budgets never write to the ledger themselves.
 * @returns {Promise<Array<{id, category, monthlyLimit, spent, remaining, percentUsed, overLimit}>>}
 */
export async function getBudgetProgress() {
  const [budgets, allTxns] = await Promise.all([getBudgets(), getAll('ledger')]);
  if (budgets.length === 0) return [];

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const monthExpenses = allTxns.filter((t) => {
    if (t.type !== 'expense') return false;
    const d = new Date(t.date);
    return d >= monthStart && d < monthEnd;
  });

  return budgets.map((b) => {
    const spent = roundMoney(monthExpenses.filter((t) => t.category === b.category).reduce((s, t) => s + t.amount, 0));
    const remaining = roundMoney(b.monthlyLimit - spent);
    const percentUsed = b.monthlyLimit > 0 ? Math.round((spent / b.monthlyLimit) * 100) : 0;
    return { ...b, spent, remaining, percentUsed, overLimit: spent > b.monthlyLimit };
  }).sort((a, b) => b.percentUsed - a.percentUsed);
}
