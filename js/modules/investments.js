// ==========================================================================
// Finora — modules/investments.js
// Investment Tracking: FD, Mutual Funds, Stocks, Gold, PPF, etc. Investing
// moves real money out of an account (a real ledger transaction);
// updating the current value is purely informational (no ledger effect,
// since Finora has no live market data — the user enters it manually);
// redeeming moves real money back in.
// ==========================================================================

import { getAll, getById, withTransaction, reqToPromise } from '../core/db.js';
import { createTransaction } from '../core/ledger.js';
import { ValidationError } from '../core/ledger.js';
import { roundMoney } from '../utils/currency.js';

export const INVESTMENT_TYPES = ['fd', 'mutual_fund', 'stocks', 'gold', 'ppf', 'other'];
const TYPE_LABELS = { fd: 'Fixed Deposit', mutual_fund: 'Mutual Fund', stocks: 'Stocks', gold: 'Gold', ppf: 'PPF', other: 'Other' };
export function investmentTypeLabel(type) { return TYPE_LABELS[type] || type; }

function newId() {
  return `inv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function getInvestments({ includeRedeemed = true } = {}) {
  const all = await getAll('investments');
  const filtered = includeRedeemed ? all : all.filter((i) => i.status === 'active');
  return filtered.sort((a, b) => new Date(b.investedDate) - new Date(a.investedDate));
}

export async function getInvestmentById(id) {
  return getById('investments', id);
}

/**
 * @param {object} input
 * @param {string} input.name
 * @param {'fd'|'mutual_fund'|'stocks'|'gold'|'ppf'|'other'} input.type
 * @param {number} input.investedAmount
 * @param {string} input.accountId money leaves this account
 * @param {string} [input.investedDate]
 * @param {string} [input.maturityDate]
 * @param {string} [input.notes]
 */
export async function createInvestment(input) {
  if (!input.name) throw new ValidationError('Give this investment a name.');
  if (!INVESTMENT_TYPES.includes(input.type)) throw new ValidationError('Choose a valid investment type.');
  if (!(Number(input.investedAmount) > 0)) throw new ValidationError('Invested amount must be greater than ₹0.');
  if (!input.accountId) throw new ValidationError('Choose which account this comes from.');

  const record = {
    id: newId(),
    name: input.name,
    type: input.type,
    investedAmount: roundMoney(Number(input.investedAmount)),
    currentValue: roundMoney(Number(input.investedAmount)),
    accountId: input.accountId,
    investedDate: input.investedDate || new Date().toISOString(),
    maturityDate: input.maturityDate || null,
    notes: input.notes || '',
    status: 'active',
    investTransactionId: null,
    redeemTransactionId: null,
    createdAt: new Date().toISOString(),
  };

  // Money leaving the account AND the investment record are written in ONE
  // atomic transaction (previously two: a crash in between left a ledger
  // entry with no investment record behind it).
  await createTransaction({
    type: 'investment', direction: 'out', accountId: input.accountId, amount: record.investedAmount,
    module: 'investments', moduleRef: record.id, description: `Invested in ${input.name}`, date: record.investedDate,
  }, {
    extraStores: ['investments'],
    sideEffect: async (tx, ledgerRecord) => {
      record.investTransactionId = ledgerRecord.id;
      tx.objectStore('investments').put(record);
    },
  });
  return record;
}

/** Updates the tracked current value — purely informational, no ledger effect. */
export async function updateCurrentValue(id, currentValue) {
  const inv = await getInvestmentById(id);
  if (!inv) throw new ValidationError('Investment not found.');
  if (inv.status !== 'active') throw new ValidationError('This investment has already been redeemed.');
  if (!(Number(currentValue) >= 0)) throw new ValidationError('Enter a valid amount.');

  const updated = { ...inv, currentValue: roundMoney(Number(currentValue)), updatedAt: new Date().toISOString() };
  await withTransaction(['investments'], 'readwrite', async (tx) => {
    await reqToPromise(tx.objectStore('investments').put(updated));
  });
  return updated;
}

/** Redeems the investment — money comes back into an account, marks it closed. */
export async function redeemInvestment(id, { accountId, redeemAmount, date }) {
  const inv = await getInvestmentById(id);
  if (!inv) throw new ValidationError('Investment not found.');
  if (inv.status !== 'active') throw new ValidationError('This investment has already been redeemed.');
  if (!(Number(redeemAmount) > 0)) throw new ValidationError('Redeem amount must be greater than ₹0.');
  if (!accountId) throw new ValidationError('Choose which account receives the money.');

  let updated;
  await createTransaction({
    type: 'investment_redemption', direction: 'in', accountId, amount: roundMoney(Number(redeemAmount)),
    module: 'investments', moduleRef: inv.id, description: `Redeemed ${inv.name}`, date,
  }, {
    extraStores: ['investments'],
    sideEffect: async (tx, ledgerRecord) => {
      const store = tx.objectStore('investments');
      const fresh = await reqToPromise(store.get(id));
      // Re-checked inside the atomic transaction: a double-click used to
      // redeem (and credit the account) twice.
      if (!fresh || fresh.status !== 'active') throw new ValidationError('This investment has already been redeemed.');
      updated = {
        ...fresh, status: 'redeemed', currentValue: roundMoney(Number(redeemAmount)),
        redeemTransactionId: ledgerRecord.id, redeemedDate: date || new Date().toISOString(),
      };
      store.put(updated);
    },
  });
  return updated;
}

/** Portfolio-wide totals: invested, current value, and gain/loss. */
export async function getPortfolioSummary() {
  const active = await getInvestments({ includeRedeemed: false });
  const totalInvested = roundMoney(active.reduce((s, i) => s + i.investedAmount, 0));
  const totalCurrentValue = roundMoney(active.reduce((s, i) => s + i.currentValue, 0));
  const totalGain = roundMoney(totalCurrentValue - totalInvested);
  const gainPercent = totalInvested > 0 ? Math.round((totalGain / totalInvested) * 1000) / 10 : 0;
  return { count: active.length, totalInvested, totalCurrentValue, totalGain, gainPercent };
}
