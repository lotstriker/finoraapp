// ==========================================================================
// Finora — core/ledger.js
// Every balance-changing money movement must go through createTransaction()
// here. Nothing else may write directly to the 'accounts' store's balance
// field. This is what keeps the ledger the true financial source of truth.
//
// Locked decisions this file implements:
//  - Credit Card accounts track usedAmount; expenses increase it, payments
//    decrease it (audit 1.3).
//  - Insufficient balance: warn, never fake success — record with
//    status = 'insufficient_balance' rather than silently succeeding (22).
//  - Credit limit is a hard block, not a warning (22).
//  - Corrections: reversal transactions linked via parentTransactionId, or
//    limited in-place edits to description/tags only (audit 1.5).
// ==========================================================================

import { withTransaction, reqToPromise, getById as dbGetById } from './db.js';
import { nextTransactionId } from './ids.js';
import { roundMoney } from '../utils/currency.js';

export class ValidationError extends Error {}
export class CreditLimitExceededError extends Error {}

const LEDGER_STORES = ['ledger', 'accounts', 'settings', 'people'];

/* ---------------------------------------------------------------------- */
/* Internal helpers                                                       */
/* ---------------------------------------------------------------------- */

function assertPositiveAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError('Amount must be greater than ₹0.');
  }
}

/** Applies an in/out effect to one account record (mutates in place). */
function applyEffect(account, effect, amount) {
  if (account.type === 'credit_card') {
    const used = account.usedAmount || 0;
    if (effect === 'out') {
      const newUsed = roundMoney(used + amount);
      if (typeof account.creditLimit === 'number' && newUsed > account.creditLimit) {
        throw new CreditLimitExceededError(
          `This would exceed the card's available limit.`
        );
      }
      account.usedAmount = newUsed;
    } else {
      account.usedAmount = roundMoney(Math.max(0, used - amount));
    }
    account.balance = -account.usedAmount;
    return;
  }

  if (effect === 'out') {
    account.balance = roundMoney((account.balance || 0) - amount);
  } else {
    account.balance = roundMoney((account.balance || 0) + amount);
  }
}

/**
 * Gets an account inside an open transaction, applies the ledger record's
 * balance effect(s) to it/them, and writes both the account(s) and the
 * ledger record. Sets record.status = 'insufficient_balance' when a normal
 * (non-credit-card) account would go negative, rather than blocking —
 * credit limit overflow blocks instead (throws CreditLimitExceededError).
 */
async function persistAtomic(record, { extraStores = [], sideEffect, precreate } = {}) {
  return withTransaction([...LEDGER_STORES, ...extraStores], 'readwrite', async (tx) => {
    if (precreate) await precreate(tx);
    const accountsStore = tx.objectStore('accounts');
    record.id = await nextTransactionId(tx);
    record.createdAt = record.createdAt || new Date().toISOString();
    record.updatedAt = record.createdAt;

    const touched = [];

    if (record.direction === 'transfer') {
      const [source, dest] = await Promise.all([
        reqToPromise(accountsStore.get(record.accountId)),
        reqToPromise(accountsStore.get(record.toAccountId)),
      ]);
      if (!source || source.archived) throw new ValidationError('Source account not found or archived.');
      if (!dest || dest.archived) throw new ValidationError('Destination account not found or archived.');
      if (record.accountId === record.toAccountId) throw new ValidationError('Source and destination accounts must be different.');

      if ((source.balance || 0) - record.amount < 0 && source.type !== 'credit_card') {
        record.status = 'insufficient_balance';
      }
      applyEffect(source, 'out', record.amount);
      applyEffect(dest, 'in', record.amount);
      touched.push(source, dest);
    } else {
      const account = await reqToPromise(accountsStore.get(record.accountId));
      if (!account || account.archived) throw new ValidationError('Account not found or archived.');

      if (record.direction === 'out' && account.type !== 'credit_card' &&
          (account.balance || 0) - record.amount < 0) {
        record.status = 'insufficient_balance';
      }
      applyEffect(account, record.direction, record.amount);
      touched.push(account);
    }

    touched.forEach((acc) => accountsStore.put(acc));

    if (record.personId && record.direction !== 'transfer') {
      const peopleStore = tx.objectStore('people');
      const person = await reqToPromise(peopleStore.get(record.personId));
      if (!person) throw new ValidationError('Person not found.');
      // Same 'out'/'in' rule as accounts: money leaving your account toward
      // a person increases what they owe you; money coming in from them
      // decreases it. This one rule covers lending, borrowing, and both
      // directions of repayment — 'type' is only for labeling (11 - People).
      if (record.direction === 'out') person.balance = roundMoney((person.balance || 0) + record.amount);
      else if (record.direction === 'in') person.balance = roundMoney((person.balance || 0) - record.amount);
      peopleStore.put(person);
    }

    tx.objectStore('ledger').put(record);
    if (sideEffect) await sideEffect(tx, record);
    return record;
  });
}

/**
 * Writes a second ledger entry inside an ALREADY-OPEN transaction (i.e.
 * from inside another call's `sideEffect`). Use this — instead of a
 * separate `createTransaction()` call — when one user action legitimately
 * produces two linked ledger entries that must succeed or fail together
 * (e.g. a committee cycle's contribution + payout). The caller's own
 * `extraStores` must already include whatever this second entry needs
 * beyond 'ledger'/'accounts'/'people'/'settings' (already always in scope).
 * @param {IDBTransaction} tx an open transaction from within a sideEffect
 * @param {object} input same shape as createTransaction's input
 */
export async function postLinkedTransaction(tx, input) {
  assertPositiveAmount(input.amount);
  if (!input.accountId) throw new ValidationError('An account is required.');

  const record = {
    id: await nextTransactionId(tx),
    date: input.date || new Date().toISOString(),
    type: input.type,
    direction: input.direction,
    status: 'completed',
    amount: roundMoney(input.amount),
    accountId: input.accountId,
    toAccountId: input.toAccountId || null,
    category: input.category || null,
    module: input.module || null,
    moduleRef: input.moduleRef || null,
    description: input.description || '',
    personId: input.personId || null,
    dueDate: input.dueDate || null,
    source: input.source || null,
    tags: input.tags || [],
    attachment: input.attachment || null,
    parentTransactionId: input.parentTransactionId || null,
    createdAt: new Date().toISOString(),
  };
  record.updatedAt = record.createdAt;

  const accountsStore = tx.objectStore('accounts');
  if (record.direction === 'transfer') {
    const [source, dest] = await Promise.all([
      reqToPromise(accountsStore.get(record.accountId)),
      reqToPromise(accountsStore.get(record.toAccountId)),
    ]);
    if (!source || source.archived) throw new ValidationError('Source account not found or archived.');
    if (!dest || dest.archived) throw new ValidationError('Destination account not found or archived.');
    applyEffect(source, 'out', record.amount);
    applyEffect(dest, 'in', record.amount);
    accountsStore.put(source);
    accountsStore.put(dest);
  } else {
    const account = await reqToPromise(accountsStore.get(record.accountId));
    if (!account || account.archived) throw new ValidationError('Account not found or archived.');
    applyEffect(account, record.direction, record.amount);
    accountsStore.put(account);
  }

  if (record.personId && record.direction !== 'transfer') {
    const peopleStore = tx.objectStore('people');
    const person = await reqToPromise(peopleStore.get(record.personId));
    if (!person) throw new ValidationError('Person not found.');
    if (record.direction === 'out') person.balance = roundMoney((person.balance || 0) + record.amount);
    else if (record.direction === 'in') person.balance = roundMoney((person.balance || 0) - record.amount);
    peopleStore.put(person);
  }

  tx.objectStore('ledger').put(record);
  return record;
}

/**
 * Reverses a transaction inside an ALREADY-OPEN transaction — the reversal
 * counterpart to postLinkedTransaction. Use this when a reversal needs to
 * touch two linked ledger entries atomically (e.g. Bid & Save: reversing
 * both the payout and the contribution, plus resetting the cycle, must all
 * succeed or fail together).
 * @param {IDBTransaction} tx an open transaction from within a sideEffect
 * @param {string} originalId
 * @param {string} [reason]
 */
export async function postLinkedReversal(tx, originalId, reason = '') {
  const original = await reqToPromise(tx.objectStore('ledger').get(originalId));
  if (!original) throw new ValidationError('Original transaction not found.');
  if (original.parentTransactionId) {
    throw new ValidationError('Cannot reverse a transaction that is itself a reversal.');
  }
  const isTransfer = original.direction === 'transfer';
  return postLinkedTransaction(tx, {
    type: original.type,
    direction: isTransfer ? 'transfer' : (original.direction === 'in' ? 'out' : 'in'),
    accountId: isTransfer ? original.toAccountId : original.accountId,
    toAccountId: isTransfer ? original.accountId : undefined,
    amount: original.amount,
    category: original.category,
    module: original.module,
    moduleRef: original.moduleRef,
    personId: original.personId,
    description: reason ? `Reversal of ${originalId}: ${reason}` : `Reversal of ${originalId}`,
    parentTransactionId: originalId,
  });
}

/* ---------------------------------------------------------------------- */
/* Public API                                                             */
/* ---------------------------------------------------------------------- */

/**
 * Creates a ledger transaction and applies its effect to the relevant
 * account balance(s) atomically.
 *
 * @param {object} input
 * @param {'income'|'expense'|'transfer'|'external_funding'|'person_lending'|
 *   'person_repayment'|'committee_payment'|'committee_payout'|'loan_emi'|
 *   'loan_disbursement'|'savings_contribution'|'savings_withdrawal'|'refund'|
 *   'balance_adjustment'} input.type
 * @param {'in'|'out'|'transfer'} input.direction
 * @param {number} input.amount
 * @param {string} input.accountId
 * @param {string} [input.toAccountId] required when direction === 'transfer'
 * @param {string} [input.category]
 * @param {string} [input.module] which module created this (e.g. 'accounts', 'income')
 * @param {string} [input.moduleRef] id of the module-specific record, if any
 * @param {string} [input.description]
 * @param {string} [input.personId]
 * @param {string[]} [input.tags]
 * @param {string} [input.date] ISO date; defaults to now
 * @param {object} [opts]
 * @param {string[]} [opts.extraStores] additional IDB store names to include in the same atomic transaction
 * @param {(tx: IDBTransaction) => void|Promise<void>} [opts.precreate] runs first, before the account is fetched — for inserting a brand-new record (e.g. a new account) that this same transaction's balance effect needs to apply to
 * @param {(tx: IDBTransaction, record: object) => void|Promise<void>} [opts.sideEffect] runs inside the same atomic transaction, after the ledger record is written — for module-specific state (e.g. marking an EMI installment paid) that must stay consistent with the ledger entry
 */
export async function createTransaction(input, opts = {}) {
  assertPositiveAmount(input.amount);
  if (!input.accountId) throw new ValidationError('An account is required.');
  if (!['in', 'out', 'transfer'].includes(input.direction)) {
    throw new ValidationError('Invalid transaction direction.');
  }
  if (input.direction === 'transfer' && !input.toAccountId) {
    throw new ValidationError('A destination account is required for a transfer.');
  }

  const record = {
    date: input.date || new Date().toISOString(),
    type: input.type,
    direction: input.direction,
    status: 'completed',
    amount: roundMoney(input.amount),
    accountId: input.accountId,
    toAccountId: input.toAccountId || null,
    category: input.category || null,
    module: input.module || null,
    moduleRef: input.moduleRef || null,
    description: input.description || '',
    personId: input.personId || null,
    dueDate: input.dueDate || null,
    source: input.source || null,
    settlesTransactionId: input.settlesTransactionId || null,
    tags: input.tags || [],
    attachment: input.attachment || null,
    parentTransactionId: input.parentTransactionId || null,
  };

  return persistAtomic(record, opts);
}

/**
 * Reverses a previously-posted transaction with a new, linked transaction
 * that applies the inverse effect. The original record is never mutated
 * (audit 1.5 — reversal, not deletion or silent edit).
 *
 * Plain ledger reversal only undoes the account/person balance effect. For
 * transactions linked to module-specific state (a paid loan installment, a
 * savings goal balance, a committee cycle), the owning module should call
 * this with `opts` to keep that state in sync — see
 * `modules/loans.js#reverseEmiPayment`, `modules/savings.js#reverseContribution`,
 * `modules/committees.js#reverseCycle` for the pattern. The generic
 * Transactions page routes to those instead of calling this directly for
 * those transaction types.
 * @param {string} originalId
 * @param {string} [reason]
 * @param {object} [opts] same shape as createTransaction's opts
 */
export async function reverseTransaction(originalId, reason = '', opts = {}) {
  const original = await dbGetById('ledger', originalId);
  if (!original) throw new ValidationError('Original transaction not found.');
  if (original.parentTransactionId) {
    throw new ValidationError('Cannot reverse a transaction that is itself a reversal.');
  }

  const isTransfer = original.direction === 'transfer';
  const reversal = {
    date: new Date().toISOString(),
    type: original.type,
    direction: isTransfer ? 'transfer' : (original.direction === 'in' ? 'out' : 'in'),
    accountId: isTransfer ? original.toAccountId : original.accountId,
    toAccountId: isTransfer ? original.accountId : undefined,
    amount: original.amount,
    category: original.category,
    module: original.module,
    moduleRef: original.moduleRef,
    personId: original.personId,
    description: reason ? `Reversal of ${originalId}: ${reason}` : `Reversal of ${originalId}`,
    parentTransactionId: originalId,
  };

  return createTransaction(reversal, opts);
}

/**
 * Limited in-place edit — only descriptive fields may change after
 * posting. Amount, date, accounts, and type stay immutable (audit 1.5).
 * @param {string} id
 * @param {{description?: string, tags?: string[]}} fields
 */
export async function updateTransactionNotes(id, fields) {
  return withTransaction(['ledger'], 'readwrite', async (tx) => {
    const store = tx.objectStore('ledger');
    const record = await reqToPromise(store.get(id));
    if (!record) throw new ValidationError('Transaction not found.');

    if (typeof fields.description === 'string') record.description = fields.description;
    if (Array.isArray(fields.tags)) record.tags = fields.tags;
    record.updatedAt = new Date().toISOString();

    store.put(record);
    return record;
  });
}

/** All ledger entries touching an account, either as source or destination, newest first. */
export async function getLedgerForAccount(accountId) {
  return withTransaction(['ledger'], 'readonly', async (tx) => {
    const store = tx.objectStore('ledger');
    const [asSource, asDest] = await Promise.all([
      reqToPromise(store.index('accountId').getAll(accountId)),
      reqToPromise(store.index('toAccountId').getAll(accountId)),
    ]);
    const merged = [...asSource, ...asDest];
    const seen = new Set();
    return merged
      .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  });
}

/** All ledger entries linked to a person, newest first. */
export async function getLedgerForPerson(personId) {
  return withTransaction(['ledger'], 'readonly', async (tx) => {
    const all = await reqToPromise(tx.objectStore('ledger').index('personId').getAll(personId));
    return all.sort((a, b) => new Date(b.date) - new Date(a.date));
  });
}

/** Most recent N ledger entries across all accounts, newest first. */
export async function getRecentTransactions(limit = 5) {
  return withTransaction(['ledger'], 'readonly', async (tx) => {
    const all = await reqToPromise(tx.objectStore('ledger').getAll());
    return all.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, limit);
  });
}
