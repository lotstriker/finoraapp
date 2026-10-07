// ==========================================================================
// Finora — modules/insights.js
// Analytics that read from the existing ledger/accounts/goals/loans/people
// data — nothing here writes anything. Net worth "as of a past date" is
// reconstructed by replaying the ledger chronologically up to that date,
// the same way core/ledger.js applies effects going forward, so this can
// never drift out of sync with the actual current balances.
// ==========================================================================

import { getAll } from '../core/db.js';
import { getAccounts } from './accounts.js';
import { getGoals } from './savings.js';
import { getPeople } from './people.js';
import { getLoans, getInstallments } from './loans.js';
import { roundMoney } from '../utils/currency.js';
import { signedIncome, signedExpense, isExpenseRelated } from '../utils/ledger-math.js';

/** Reconstructs the combined balance of the given accounts as of a past date. */
function accountsBalanceAsOf(ledger, accountIds, asOfDate) {
  const idSet = new Set(accountIds);
  let total = 0;
  for (const t of ledger) {
    if (new Date(t.date) > asOfDate) continue;
    if (t.direction === 'transfer') {
      if (idSet.has(t.accountId)) total -= t.amount;
      if (idSet.has(t.toAccountId)) total += t.amount;
    } else if (t.direction === 'out' && idSet.has(t.accountId)) {
      total -= t.amount;
    } else if (t.direction === 'in' && idSet.has(t.accountId)) {
      total += t.amount;
    }
  }
  return roundMoney(total);
}

/** Reconstructs a savings goal's total balance across all goals as of a past date. */
function savingsTotalAsOf(ledger, asOfDate) {
  let total = 0;
  for (const t of ledger) {
    if (new Date(t.date) > asOfDate) continue;
    if (t.type === 'savings_contribution') total += t.amount;
    else if (t.type === 'savings_withdrawal') total -= t.amount;
  }
  return roundMoney(total);
}

/** Reconstructs the net people balance (positive = owed to you) as of a past date. */
function peopleNetAsOf(ledger, asOfDate) {
  let total = 0;
  for (const t of ledger) {
    if (new Date(t.date) > asOfDate) continue;
    if (!t.personId) continue;
    if (t.direction === 'out') total += t.amount;
    else if (t.direction === 'in') total -= t.amount;
  }
  return roundMoney(total);
}

/** Reconstructs total loan principal still outstanding as of a past date. */
async function loansOutstandingAsOf(loans, asOfDate) {
  let total = 0;
  for (const loan of loans) {
    if (new Date(loan.startDate) > asOfDate) continue; // loan didn't exist yet
    const installments = await getInstallments(loan.id);
    // principal only (matches the dashboard): future interest isn't owed yet
    const part = (i) => i.principalComponent ?? i.amount;
    const paidByThen = installments.filter((i) => i.paidDate && new Date(i.paidDate) <= asOfDate).reduce((s, i) => s + part(i), 0);
    const totalPrincipal = installments.reduce((s, i) => s + part(i), 0);
    total += Math.max(0, totalPrincipal - paidByThen);
  }
  return roundMoney(total);
}

/**
 * Net worth (accounts + savings + people-receivable − loans-outstanding)
 * at the end of each of the last `monthsBack` months, plus the current
 * value as the final point.
 */
export async function getNetWorthHistory(monthsBack = 12) {
  const [ledger, accounts, loans] = await Promise.all([getAll('ledger'), getAccounts({ includeArchived: true }), getLoans({ includeClosed: true })]);
  const accountIds = accounts.map((a) => a.id);

  const now = new Date();
  const points = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const checkpoint = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59); // last instant of that month
    const label = checkpoint.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
    const netWorth = roundMoney(
      accountsBalanceAsOf(ledger, accountIds, checkpoint) +
      savingsTotalAsOf(ledger, checkpoint) +
      peopleNetAsOf(ledger, checkpoint) -
      (await loansOutstandingAsOf(loans, checkpoint))
    );
    points.push({ label, netWorth, date: checkpoint.toISOString() });
  }
  return points;
}

/**
 * Compares this year's monthly income/expense totals against last year's,
 * month by month (Jan–Dec, using whatever months have data in each year).
 */
export async function getYearOverYearComparison() {
  const ledger = await getAll('ledger');
  const thisYear = new Date().getFullYear();
  const lastYear = thisYear - 1;

  const monthly = (year) => {
    const months = Array.from({ length: 12 }, () => ({ income: 0, expense: 0 }));
    ledger.forEach((t) => {
      const d = new Date(t.date);
      if (d.getFullYear() !== year) return;
      months[d.getMonth()].income += signedIncome(t);
      months[d.getMonth()].expense += signedExpense(t);
    });
    return months;
  };

  const thisYearData = monthly(thisYear);
  const lastYearData = monthly(lastYear);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  return monthNames.map((label, i) => ({
    label,
    thisYearIncome: roundMoney(thisYearData[i].income),
    thisYearExpense: roundMoney(thisYearData[i].expense),
    lastYearIncome: roundMoney(lastYearData[i].income),
    lastYearExpense: roundMoney(lastYearData[i].expense),
  }));
}

/**
 * Auto-generated, plain-language spending observations comparing this
 * month to last month, per category. Purely descriptive — no advice.
 */
export async function getSpendingInsights() {
  const ledger = await getAll('ledger');
  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = thisMonthStart;

  const byCategory = (from, to) => {
    const map = {};
    ledger.filter((t) => isExpenseRelated(t) && new Date(t.date) >= from && new Date(t.date) < to)
      .forEach((t) => { const cat = t.category || 'Uncategorized'; map[cat] = roundMoney((map[cat] || 0) + signedExpense(t)); });
    return map;
  };

  const thisMonth = byCategory(thisMonthStart, now);
  const lastMonth = byCategory(lastMonthStart, lastMonthEnd);

  const insights = [];
  const categories = new Set([...Object.keys(thisMonth), ...Object.keys(lastMonth)]);
  for (const cat of categories) {
    const curr = thisMonth[cat] || 0;
    const prev = lastMonth[cat] || 0;
    if (prev === 0 && curr === 0) continue;
    if (prev === 0) {
      insights.push({ category: cat, type: 'new', text: `New this month: ${cat} spending of ${curr}.`, current: curr, previous: prev });
      continue;
    }
    const pctChange = Math.round(((curr - prev) / prev) * 100);
    if (Math.abs(pctChange) < 10) continue; // ignore noise
    insights.push({
      category: cat,
      type: pctChange > 0 ? 'increase' : 'decrease',
      pctChange: Math.abs(pctChange),
      current: curr,
      previous: prev,
      text: pctChange > 0
        ? `${cat} spending is up ${Math.abs(pctChange)}% vs last month.`
        : `${cat} spending is down ${Math.abs(pctChange)}% vs last month.`,
    });
  }
  return insights.sort((a, b) => Math.abs(b.pctChange || 100) - Math.abs(a.pctChange || 100));
}
