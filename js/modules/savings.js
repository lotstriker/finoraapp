// ==========================================================================
// Finora — modules/savings.js
// Locked decisions:
//  - Contribution is an internal allocation, NOT an expense: type
//    'savings_contribution', direction 'out' from the source account, but
//    no toAccountId — the destination is a goal, not an account (16, audit 1.4).
//  - Each goal keeps its own currentAmount; there is no shared savings pool.
// ==========================================================================

import { withTransaction, reqToPromise, getAll, getById } from '../core/db.js';
import { createTransaction, reverseTransaction, ValidationError } from '../core/ledger.js';
import { newId } from '../core/ids.js';

export async function getGoals({ includeArchived = false } = {}) {
  const all = await getAll('savings_goals');
  const filtered = includeArchived ? all : all.filter((g) => !g.archived);
  return filtered.sort((a, b) => {
    if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

export async function getGoalById(id) {
  return getById('savings_goals', id);
}

export function goalProgress(goal) {
  const percent = goal.targetAmount > 0 ? Math.min(100, (goal.currentAmount / goal.targetAmount) * 100) : 0;
  return { percent, remaining: Math.max(0, goal.targetAmount - goal.currentAmount) };
}

/**
 * @param {object} input
 * @param {string} input.name
 * @param {number} input.targetAmount
 * @param {string} [input.targetDate] ISO date, informational only (16)
 * @param {'low'|'medium'|'high'} [input.priority]
 */
export async function createGoal(input) {
  if (!input.name?.trim()) throw new ValidationError('Goal name is required.');
  if (!(Number(input.targetAmount) > 0)) throw new ValidationError('Target amount must be greater than ₹0.');

  const goal = {
    id: newId('goal'),
    name: input.name.trim(),
    targetAmount: Number(input.targetAmount),
    currentAmount: 0,
    targetDate: input.targetDate || null,
    priority: input.priority || 'medium',
    archived: false,
    createdAt: new Date().toISOString(),
  };

  await withTransaction(['savings_goals'], 'readwrite', (tx) => {
    tx.objectStore('savings_goals').put(goal);
  });
  return goal;
}

/**
 * Moves money from an account into this goal. Not an expense — an internal
 * allocation, so net worth is unchanged (16).
 */
export async function contribute(goalId, { accountId, amount, description, date }) {
  const amt = Number(amount);
  if (!(amt > 0)) throw new ValidationError('Amount must be greater than ₹0.');

  return createTransaction({
    type: 'savings_contribution',
    direction: 'out',
    accountId,
    amount: amt,
    module: 'savings',
    moduleRef: goalId,
    description: description || 'Savings contribution',
    date,
  }, {
    extraStores: ['savings_goals', 'savings_contributions'],
    sideEffect: async (tx, record) => {
      const goalStore = tx.objectStore('savings_goals');
      const goal = await reqToPromise(goalStore.get(goalId));
      if (!goal) throw new ValidationError('Savings goal not found.');
      goal.currentAmount = (goal.currentAmount || 0) + amt;
      goalStore.put(goal);

      tx.objectStore('savings_contributions').put({
        id: newId('sc'), goalId, amount: amt, direction: 'contribution',
        date: record.date, transactionId: record.id, description: record.description,
      });
    },
  });
}

/** Moves money out of a goal back into an account. */
export async function withdraw(goalId, { accountId, amount, description, date }) {
  const amt = Number(amount);
  if (!(amt > 0)) throw new ValidationError('Amount must be greater than ₹0.');

  const goal = await getGoalById(goalId);
  if (!goal) throw new ValidationError('Savings goal not found.');
  if (amt > goal.currentAmount) throw new ValidationError('Cannot withdraw more than the goal currently holds.');

  return createTransaction({
    type: 'savings_withdrawal',
    direction: 'in',
    accountId,
    amount: amt,
    module: 'savings',
    moduleRef: goalId,
    description: description || 'Savings withdrawal',
    date,
  }, {
    extraStores: ['savings_goals', 'savings_contributions'],
    sideEffect: async (tx, record) => {
      const goalStore = tx.objectStore('savings_goals');
      const g = await reqToPromise(goalStore.get(goalId));
      g.currentAmount = Math.max(0, (g.currentAmount || 0) - amt);
      goalStore.put(g);

      tx.objectStore('savings_contributions').put({
        id: newId('sc'), goalId, amount: amt, direction: 'withdrawal',
        date: record.date, transactionId: record.id, description: record.description,
      });
    },
  });
}

/**
 * Reverses a contribution or withdrawal: undoes the ledger effect AND
 * correctly adjusts the goal's currentAmount back. Generic ledger reversal
 * alone fixed the account balance but left the goal balance untouched.
 */
export async function reverseContribution(transactionId, reason = '') {
  const original = await getById('ledger', transactionId);
  if (!original) throw new ValidationError('Transaction not found.');
  if (!['savings_contribution', 'savings_withdrawal'].includes(original.type)) {
    throw new ValidationError('This is not a savings contribution or withdrawal.');
  }
  const goalId = original.moduleRef;
  const wasContribution = original.type === 'savings_contribution';

  await reverseTransaction(transactionId, reason, {
    extraStores: ['savings_goals', 'savings_contributions'],
    sideEffect: async (tx, record) => {
      const goalStore = tx.objectStore('savings_goals');
      const goal = await reqToPromise(goalStore.get(goalId));
      if (!goal) throw new ValidationError('Savings goal not found.');
      // A contribution reversal removes money from the goal; a withdrawal
      // reversal restores it — the inverse of what each action originally did.
      goal.currentAmount = wasContribution
        ? Math.max(0, (goal.currentAmount || 0) - original.amount)
        : (goal.currentAmount || 0) + original.amount;
      goalStore.put(goal);

      tx.objectStore('savings_contributions').put({
        id: newId('sc'), goalId, amount: original.amount,
        direction: wasContribution ? 'withdrawal' : 'contribution',
        date: record.date, transactionId: record.id,
        description: record.description,
      });
    },
  });
}

export async function getContributionHistory(goalId) {
  return withTransaction(['savings_contributions'], 'readonly', async (tx) => {
    const all = await reqToPromise(tx.objectStore('savings_contributions').index('goalId').getAll(goalId));
    return all.sort((a, b) => new Date(b.date) - new Date(a.date));
  });
}

export async function archiveGoal(id) {
  return withTransaction(['savings_goals'], 'readwrite', async (tx) => {
    const store = tx.objectStore('savings_goals');
    const goal = await reqToPromise(store.get(id));
    if (!goal) throw new ValidationError('Goal not found.');
    goal.archived = true;
    store.put(goal);
    return goal;
  });
}

export async function unarchiveGoal(id) {
  return withTransaction(['savings_goals'], 'readwrite', async (tx) => {
    const store = tx.objectStore('savings_goals');
    const goal = await reqToPromise(store.get(id));
    if (!goal) throw new ValidationError('Goal not found.');
    goal.archived = false;
    store.put(goal);
    return goal;
  });
}
