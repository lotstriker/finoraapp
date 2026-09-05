// ==========================================================================
// Finora — pages/dashboard.js
// "Dashboard is a quick overview, not a complete analytics page" (18).
// Every card here is a real aggregate from the database — nothing invented.
//
// Second-opinion-review fix: "Total Balance" only summed account balances,
// so a Savings contribution made it look like money vanished (it didn't —
// it moved into a goal, still yours). Net Worth now properly includes
// savings goals + people receivable, minus loans outstanding.
// ==========================================================================

import { getAccounts } from '../modules/accounts.js';
import { getRecentTransactions } from '../core/ledger.js';
import { getAll } from '../core/db.js';
import { getCommittees, getCycles, committeeProgress } from '../modules/committees.js';
import { getLoans, getInstallments, loanProgress } from '../modules/loans.js';
import { getGoals } from '../modules/savings.js';
import { getPeople } from '../modules/people.js';
import { formatCurrency, formatSignedCurrency } from '../utils/currency.js';
import { formatDate, escapeHtml } from '../utils/dom.js';
import { icons } from '../utils/icons.js';

function isThisMonth(iso) {
  const d = new Date(iso);
  const now = new Date();
  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

function statCard({ label, value, valueClass = '', sub = '', href = '' }) {
  return `
    <a href="${href}" class="card stat-card" style="${href ? '' : 'pointer-events:none;'}">
      <span class="stat-label">${label}</span>
      <span class="amount amount--lg num ${valueClass}">${value}</span>
      ${sub ? `<span class="text-xs text-faint">${sub}</span>` : ''}
    </a>
  `;
}

function txnRow(txn, accountsById) {
  const dirClass = txn.direction === 'in' ? 'in' : txn.direction === 'out' ? 'out' : 'transfer';
  const acc = accountsById[txn.accountId];
  const toAcc = txn.toAccountId ? accountsById[txn.toAccountId] : null;
  const sub = toAcc ? `${acc?.name || '—'} → ${toAcc.name}` : (acc?.name || '—');

  return `
    <a href="#/transactions?open=${txn.id}" class="list-row">
      <div class="row-icon">${icons[txn.type] || icons.other}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(txn.description || txn.type)}</div>
        <div class="row-sub">${escapeHtml(sub)} · ${formatDate(txn.date)}</div>
      </div>
      <span class="amount num amount--${dirClass}">${formatSignedCurrency(txn.amount, txn.direction)}</span>
    </a>
  `;
}

export async function renderDashboard(container) {
  const [accounts, recent, allTxns, committees, loans, goals, people] = await Promise.all([
    getAccounts(),
    getRecentTransactions(6),
    getAll('ledger'),
    getCommittees(),
    getLoans({ includeClosed: false }),
    getGoals(),
    getPeople(),
  ]);

  const totalBalance = accounts.reduce((sum, a) => sum + (a.balance || 0), 0);
  const accountsById = Object.fromEntries(accounts.map((a) => [a.id, a]));

  const monthTxns = allTxns.filter((t) => isThisMonth(t.date));
  const monthIncome = monthTxns.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const monthExpense = monthTxns.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);

  // Net Worth = accounts + savings goals + people receivable (signed) - loans outstanding
  const totalSavings = goals.reduce((s, g) => s + (g.currentAmount || 0), 0);
  const totalPeopleNet = people.reduce((s, p) => s + (p.balance || 0), 0);
  let totalLoansOutstanding = 0;
  for (const loan of loans) {
    const installments = await getInstallments(loan.id);
    totalLoansOutstanding += loanProgress(installments).remainingAmount;
  }
  const netWorth = totalBalance + totalSavings + totalPeopleNet - totalLoansOutstanding;

  // Bid & Save overview
  const activeCommittees = committees.filter((c) => c.status === 'active');
  let bidSaveContribution = 0;
  let bidSaveTotalSaving = 0;
  for (const c of activeCommittees) {
    const cycles = await getCycles(c.id);
    const progress = committeeProgress(cycles);
    bidSaveTotalSaving += progress.totalSaving;
    const nextPending = cycles.find((cy) => cy.status !== 'recorded');
    if (nextPending) bidSaveContribution += c.baseContribution * c.userMemberships;
  }

  // Loans overview — nearest upcoming EMI across active loans
  let nextEmi = null;
  for (const loan of loans) {
    const installments = await getInstallments(loan.id);
    const pending = installments.find((i) => i.status !== 'paid');
    if (pending && (!nextEmi || new Date(pending.dueDate) < new Date(nextEmi.dueDate))) {
      nextEmi = { ...pending, loanName: loan.name };
    }
  }

  container.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Dashboard</h1>
      </div>

      <div class="grid grid-cards" style="margin-bottom: var(--sp-6);">
        ${statCard({ label: 'Net Worth', value: formatCurrency(netWorth), valueClass: netWorth >= 0 ? 'amount--in' : 'amount--out', sub: 'Accounts + Savings + People − Loans' })}
        ${statCard({ label: 'Total Balance', value: formatCurrency(totalBalance), sub: `${accounts.length} active account${accounts.length === 1 ? '' : 's'}`, href: '#/accounts' })}
        ${statCard({ label: 'Income · This Month', value: formatCurrency(monthIncome), valueClass: 'amount--in', href: '#/income' })}
        ${statCard({ label: 'Expenses · This Month', value: formatCurrency(monthExpense), valueClass: 'amount--out', href: '#/expenses' })}
        ${statCard({ label: 'Net Cash Flow · This Month', value: formatCurrency(monthIncome - monthExpense), valueClass: (monthIncome - monthExpense) >= 0 ? 'amount--in' : 'amount--out', sub: 'Income − Expenses (savings/transfers not included)', href: '#/reports' })}
      </div>

      ${(activeCommittees.length || loans.length || goals.length) ? `
      <div class="grid grid-cards" style="margin-bottom: var(--sp-6);">
        ${activeCommittees.length ? statCard({
          label: 'Bid & Save',
          value: formatCurrency(bidSaveContribution),
          sub: `${activeCommittees.length} active · ${formatCurrency(bidSaveTotalSaving)} profit so far`,
          href: '#/bidsave',
        }) : ''}
        ${loans.length ? statCard({
          label: 'Loans Outstanding',
          value: formatCurrency(totalLoansOutstanding),
          valueClass: 'amount--out',
          sub: nextEmi ? `Next: ${escapeHtml(nextEmi.loanName)} ${formatCurrency(nextEmi.amount)} · ${formatDate(nextEmi.dueDate)}` : `${loans.length} active loan${loans.length === 1 ? '' : 's'}`,
          href: '#/loans',
        }) : ''}
        ${goals.length ? statCard({
          label: 'Savings',
          value: formatCurrency(totalSavings),
          valueClass: 'amount--in',
          sub: `${goals.length} goal${goals.length === 1 ? '' : 's'}`,
          href: '#/savings',
        }) : ''}
      </div>` : ''}

      <h2 style="font-size: var(--fs-md); font-weight: 650; margin-bottom: var(--sp-3);">Recent Transactions</h2>
      <div class="list">
        ${recent.length
          ? recent.map((t) => txnRow(t, accountsById)).join('')
          : `<div class="empty-state">
               <h3>No transactions yet</h3>
               <p>Add an account and record your first transaction to see it here.</p>
             </div>`
        }
      </div>
    </div>
  `;
}
