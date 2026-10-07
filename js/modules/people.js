// ==========================================================================
// Finora — modules/people.js
// Locked decision (audit 1.1): People are NOT Accounts. A person never has
// an accountId — money movement with them is linked purely via personId
// on the ledger, and core/ledger.js keeps person.balance in sync
// automatically, in the same atomic write as the ledger entry.
//
// Balance sign convention: positive = they owe you, negative = you owe them.
// ==========================================================================

import { withTransaction, reqToPromise, getAll, getById } from '../core/db.js';
import { createTransaction, getLedgerForPerson, ValidationError } from '../core/ledger.js';
import { newId } from '../core/ids.js';

export class DuplicateNameError extends Error { constructor(m) { super(m); this.name = 'DuplicateNameError'; } }

export async function getPeople({ includeArchived = false } = {}) {
  const all = await getAll('people');
  const filtered = includeArchived ? all : all.filter((p) => !p.archived);
  return filtered.sort((a, b) => {
    if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

export async function getPersonById(id) {
  return getById('people', id);
}

/**
 * @param {object} input
 * @param {string} input.name
 * @param {string} [input.phone]
 * @param {string} [input.email]
 * @param {string} [input.notes]
 * @param {boolean} [input.confirmDuplicate]
 */
export async function createPerson(input) {
  const name = (input.name || '').trim();
  if (!name) throw new ValidationError('Name is required.');

  const existing = await getPeople({ includeArchived: true });
  const dup = existing.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (dup && !input.confirmDuplicate) {
    throw new DuplicateNameError(`A person named "${name}" already exists. Continue anyway?`);
  }

  const person = {
    id: newId('per'),
    name,
    phone: input.phone || '',
    email: input.email || '',
    notes: input.notes || '',
    balance: 0,
    archived: false,
    createdAt: new Date().toISOString(),
  };

  await withTransaction(['people'], 'readwrite', (tx) => {
    tx.objectStore('people').put(person);
  });

  return person;
}

export async function archivePerson(id) {
  return withTransaction(['people'], 'readwrite', async (tx) => {
    const store = tx.objectStore('people');
    const person = await reqToPromise(store.get(id));
    if (!person) throw new ValidationError('Person not found.');
    person.archived = true;
    store.put(person);
    return person;
  });
}

export async function unarchivePerson(id) {
  return withTransaction(['people'], 'readwrite', async (tx) => {
    const store = tx.objectStore('people');
    const person = await reqToPromise(store.get(id));
    if (!person) throw new ValidationError('Person not found.');
    person.archived = false;
    store.put(person);
    return person;
  });
}

/* ---------------------------------------------------------------------- */
/* Money movement — four actions covering every direction (11 - People)   */
/* ---------------------------------------------------------------------- */

/**
 * You give money to this person (they owe you more).
 * @param {string} personId
 * @param {object} input
 * @param {string} input.accountId
 * @param {number} input.amount
 * @param {string} [input.description]
 * @param {string} [input.date]
 * @param {string} [input.dueDate] when you expect this back
 * @param {string} [input.purpose] e.g. "Travel", "Medical" — shown as the transaction's category
 */
export async function lendToPerson(personId, { accountId, amount, description, date, dueDate, purpose, tags }) {
  return createTransaction({
    type: 'person_lending', direction: 'out', accountId, amount, personId,
    module: 'people', description: description || 'Lent money',
    category: purpose, dueDate, tags, date,
  });
}

/**
 * This person pays you back (they owe you less).
 * @param {string} [input.settlesTransactionId] which of your earlier "Lend Money" entries this repayment applies to (optional — omit for a general/unspecified repayment)
 */
export async function recordRepaymentReceived(personId, { accountId, amount, description, date, settlesTransactionId }) {
  return createTransaction({
    type: 'person_repayment', direction: 'in', accountId, amount, personId,
    module: 'people', description: description || 'Repayment received',
    settlesTransactionId, date,
  });
}

/**
 * This person gives you money — you're borrowing from them (you owe them more).
 * @param {string} personId
 * @param {object} input
 * @param {string} input.accountId
 * @param {number} input.amount
 * @param {string} [input.description]
 * @param {string} [input.date]
 * @param {string} [input.dueDate] when you plan to pay this back
 * @param {string} [input.purpose]
 */
export async function borrowFromPerson(personId, { accountId, amount, description, date, dueDate, purpose, tags }) {
  return createTransaction({
    type: 'person_lending', direction: 'in', accountId, amount, personId,
    module: 'people', description: description || 'Borrowed money',
    category: purpose, dueDate, tags, date,
  });
}

/**
 * You pay this person back (you owe them less).
 * @param {string} [input.settlesTransactionId] which of your earlier "Borrowed Money" entries this repayment applies to (optional)
 */
export async function repayPerson(personId, { accountId, amount, description, date, settlesTransactionId }) {
  return createTransaction({
    type: 'person_repayment', direction: 'out', accountId, amount, personId,
    module: 'people', description: description || 'Repaid',
    settlesTransactionId, date,
  });
}

/**
 * A date-only status for a lend/borrow entry's dueDate — this compares
 * dates only, it does NOT track whether this specific loan has been
 * settled (the person's overall `balance` already tracks net outstanding;
 * this is just "is this due date in the past/today/future").
 */
export function dueDateStatus(dueDate) {
  if (!dueDate) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate); due.setHours(0, 0, 0, 0);
  if (due.getTime() === today.getTime()) return 'due_today';
  return due < today ? 'overdue' : 'upcoming';
}

/**
 * Lists this person's individual "Lend Money"/"Borrowed Money" entries with
 * how much of each has been settled by repayments that specifically
 * reference it (via settlesTransactionId). Repayments that don't reference
 * a specific entry (settlesTransactionId is null) aren't counted here —
 * they still reduce the person's overall balance, just not tied to one
 * lending record.
 * @param {string} personId
 * @param {'out'|'in'} direction 'out' = money you lent them; 'in' = money you borrowed from them
 */
export async function getOutstandingLendings(personId, direction) {
  const history = await getLedgerForPerson(personId);
  const lendings = history.filter((t) => t.type === 'person_lending' && t.direction === direction && !t.parentTransactionId);
  const repayments = history.filter((t) => t.type === 'person_repayment' && t.settlesTransactionId);

  return lendings.map((lend) => {
    const settledAmount = repayments
      .filter((r) => r.settlesTransactionId === lend.id)
      .reduce((s, r) => s + r.amount, 0);
    const remaining = Math.max(0, lend.amount - settledAmount);
    let status;
    if (remaining <= 0) status = 'settled';
    else if (settledAmount > 0) status = 'partial';
    else status = dueDateStatus(lend.dueDate) || 'outstanding';
    return { ...lend, settledAmount, remaining, settlementStatus: status };
  });
}

export { getLedgerForPerson };
