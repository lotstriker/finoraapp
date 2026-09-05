// ==========================================================================
// Finora — modules/categories.js
// ==========================================================================

import { withTransaction, reqToPromise, getAll } from '../core/db.js';
import { newId } from '../core/ids.js';
import { ValidationError } from '../core/ledger.js';

const DEFAULT_INCOME = ['Salary', 'Freelance', 'Business', 'Investment', 'Gift', 'Refund', 'Other Income'];
const DEFAULT_EXPENSE = ['Food & Dining', 'Groceries', 'Transport', 'Utilities', 'Rent', 'Shopping', 'Entertainment', 'Health', 'Education', 'Travel', 'EMI / Loan', 'Other Expense'];

/** Inserts default categories once, if the categories store is empty. Safe to call on every boot. */
export async function seedDefaultCategories() {
  const existing = await getAll('categories');
  if (existing.length > 0) return;

  const now = new Date().toISOString();
  const rows = [
    ...DEFAULT_INCOME.map((name) => ({ id: newId('cat'), name, kind: 'income', archived: false, createdAt: now })),
    ...DEFAULT_EXPENSE.map((name) => ({ id: newId('cat'), name, kind: 'expense', archived: false, createdAt: now })),
  ];

  await withTransaction(['categories'], 'readwrite', (tx) => {
    const store = tx.objectStore('categories');
    rows.forEach((r) => store.put(r));
  });
}

/** @param {'income'|'expense'} kind */
export async function getCategories(kind, { includeArchived = false } = {}) {
  const all = await getAll('categories');
  return all
    .filter((c) => c.kind === kind && (includeArchived || !c.archived))
    .sort((a, b) => (a.archived === b.archived ? a.name.localeCompare(b.name) : a.archived ? 1 : -1));
}

export async function createCategory({ name, kind }) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new ValidationError('Category name is required.');
  if (!['income', 'expense'].includes(kind)) throw new ValidationError('Invalid category kind.');

  const existing = await getCategories(kind, { includeArchived: true });
  const dup = existing.find((c) => c.name.toLowerCase() === trimmed.toLowerCase());
  if (dup) return dup;

  const category = { id: newId('cat'), name: trimmed, kind, archived: false, createdAt: new Date().toISOString() };
  return withTransaction(['categories'], 'readwrite', async (tx) => {
    tx.objectStore('categories').put(category);
    return category;
  });
}

/** Hides a category from selection everywhere, without deleting past transactions that used it. */
export async function archiveCategory(id) {
  return withTransaction(['categories'], 'readwrite', async (tx) => {
    const store = tx.objectStore('categories');
    const cat = await reqToPromise(store.get(id));
    if (!cat) throw new ValidationError('Category not found.');
    cat.archived = true;
    store.put(cat);
    return cat;
  });
}

export async function unarchiveCategory(id) {
  return withTransaction(['categories'], 'readwrite', async (tx) => {
    const store = tx.objectStore('categories');
    const cat = await reqToPromise(store.get(id));
    if (!cat) throw new ValidationError('Category not found.');
    cat.archived = false;
    store.put(cat);
    return cat;
  });
}
