// ==========================================================================
// Finora — modules/accounts.js
// Locked decisions this file implements:
//  - Account Types: bank, upi_wallet, cash, credit_card, other.
//    'person' is intentionally NOT here — People stay fully separate from
//    Accounts (audit 1.1); person-linked money uses personId on the ledger.
//  - Entering a non-zero Initial Balance at creation time automatically
//    fires an external_funding ledger transaction (audit 1.2).
//  - Credit Card creditLimit/usedAmount are real fields (audit 1.3),
//    balance effects handled centrally in core/ledger.js.
//  - Accounts with ledger history are archived, never hard-deleted (07).
// ==========================================================================

import { withTransaction, reqToPromise, getAll, getById } from '../core/db.js';
import { createTransaction, getLedgerForAccount, ValidationError } from '../core/ledger.js';
import { newId } from '../core/ids.js';

export const ACCOUNT_TYPES = [
  { value: 'bank', label: 'Bank' },
  { value: 'upi_wallet', label: 'UPI / Wallet' },
  { value: 'cash', label: 'Cash' },
  { value: 'credit_card', label: 'Credit Card' },
  { value: 'other', label: 'Other' },
];

export class DuplicateNameError extends Error {}

/** All accounts, optionally including archived ones. Active-first, then by name. */
export async function getAccounts({ includeArchived = false } = {}) {
  const all = await getAll('accounts');
  const filtered = includeArchived ? all : all.filter((a) => !a.archived);
  return filtered.sort((a, b) => {
    if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

export async function getAccountById(id) {
  return getById('accounts', id);
}

/**
 * Creates a new account. If `initialBalance` > 0, immediately posts an
 * external_funding ledger transaction for it (audit 1.2) — the account
 * never starts with a "fake" silent balance.
 *
 * @param {object} input
 * @param {string} input.name
 * @param {string} input.type one of ACCOUNT_TYPES values
 * @param {number} [input.initialBalance]
 * @param {number} [input.creditLimit] required for type === 'credit_card'
 * @param {boolean} [input.confirmDuplicate] set true to bypass the duplicate-name warning
 */
export async function createAccount(input) {
  const name = (input.name || '').trim();
  if (!name) throw new ValidationError('Account name is required.');
  if (!ACCOUNT_TYPES.some((t) => t.value === input.type)) {
    throw new ValidationError('Please select a valid account type.');
  }
  if (input.type === 'credit_card' && !(Number(input.creditLimit) > 0)) {
    throw new ValidationError('Credit limit must be greater than ₹0 for a credit card.');
  }

  const existing = await getAccounts({ includeArchived: true });
  const dup = existing.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (dup && !input.confirmDuplicate) {
    throw new DuplicateNameError(`An account named "${name}" already exists. Continue anyway?`);
  }

  const account = {
    id: newId('acc'),
    name,
    type: input.type,
    balance: 0,
    creditLimit: input.type === 'credit_card' ? Number(input.creditLimit) : null,
    usedAmount: input.type === 'credit_card' ? 0 : null,
    archived: false,
    createdAt: new Date().toISOString(),
  };

  const initial = Number(input.initialBalance) || 0;

  if (initial > 0 && input.type !== 'credit_card') {
    // Account creation + its initial-balance ledger entry as ONE atomic
    // transaction — previously these were two separate operations, so a
    // failure between them could leave an account with no funding record.
    await createTransaction({
      type: 'external_funding',
      direction: 'in',
      accountId: account.id,
      amount: initial,
      module: 'accounts',
      description: 'Initial balance',
    }, {
      precreate: async (tx) => { tx.objectStore('accounts').put(account); },
    });
  } else {
    await withTransaction(['accounts'], 'readwrite', (tx) => {
      tx.objectStore('accounts').put(account);
    });
  }

  return getAccountById(account.id);
}

/**
 * Adds money to an account outside of a dedicated Income/Transfer flow.
 * @param {string} accountId
 * @param {object} input
 * @param {number} input.amount
 * @param {'income'|'external_funding'} input.source
 * @param {string} [input.description]
 * @param {string} [input.date]
 */
export async function addMoney(accountId, input) {
  const type = input.source === 'income' ? 'income' : 'external_funding';
  return createTransaction({
    type,
    direction: 'in',
    accountId,
    amount: input.amount,
    module: 'accounts',
    description: input.description || (type === 'income' ? 'Income' : 'Money added'),
    date: input.date,
  });
}

/** Hides the account from active lists but preserves all its data (03, 07). */
export async function archiveAccount(id) {
  return withTransaction(['accounts'], 'readwrite', async (tx) => {
    const store = tx.objectStore('accounts');
    const account = await reqToPromise(store.get(id));
    if (!account) throw new ValidationError('Account not found.');
    account.archived = true;
    store.put(account);
    return account;
  });
}

export async function unarchiveAccount(id) {
  return withTransaction(['accounts'], 'readwrite', async (tx) => {
    const store = tx.objectStore('accounts');
    const account = await reqToPromise(store.get(id));
    if (!account) throw new ValidationError('Account not found.');
    account.archived = false;
    store.put(account);
    return account;
  });
}

/**
 * Permanently deletes an account — only allowed when it has no ledger
 * history at all. Otherwise the caller should archive instead (07).
 */
export async function deleteAccount(id) {
  const history = await getLedgerForAccount(id);
  if (history.length > 0) {
    throw new ValidationError('This account has transaction history and cannot be deleted. Archive it instead.');
  }
  return withTransaction(['accounts'], 'readwrite', (tx) => {
    tx.objectStore('accounts').delete(id);
  });
}

/**
 * Reconciles this account to a known-correct actual balance (e.g. matching
 * a bank statement), posting the exact difference as a balance_adjustment
 * ledger entry rather than silently overwriting the balance.
 * @param {string} accountId
 * @param {object} input
 * @param {number} input.actualBalance the correct balance, per an outside source
 * @param {string} [input.reason]
 * @param {string} [input.date]
 */
export async function adjustBalance(accountId, input) {
  const account = await getAccountById(accountId);
  if (!account) throw new ValidationError('Account not found.');

  const actual = Number(input.actualBalance);
  if (!Number.isFinite(actual)) throw new ValidationError('Enter a valid balance.');

  const current = account.type === 'credit_card' ? account.balance : account.balance;
  const difference = actual - current;
  if (difference === 0) throw new ValidationError('The actual balance already matches — nothing to adjust.');

  return createTransaction({
    type: 'balance_adjustment',
    direction: difference > 0 ? 'in' : 'out',
    accountId,
    amount: Math.abs(difference),
    module: 'accounts',
    description: input.reason || 'Balance adjustment',
    date: input.date,
  });
}

export function accountTypeLabel(type) {
  return ACCOUNT_TYPES.find((t) => t.value === type)?.label || type;
}
