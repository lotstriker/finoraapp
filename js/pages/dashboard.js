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
import { getPeople, getOutstandingLendings, dueDateStatus } from '../modules/people.js';
import { getUpcomingRules } from '../modules/recurring.js';
import { getEnabledModules } from '../modules/preferences.js';
import { getBackupReminderStatus } from '../modules/backup.js';
import { getBudgetProgress } from '../modules/budgets.js';
import { getScheduledTransactions, daysUntil } from '../modules/scheduled.js';
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

function attentionRow({ icon, title, sub, amount, amountClass = '', href = '' }) {
  return `
    <a href="${href}" class="list-row">
      <div class="row-icon">${icon}</div>
      <div class="row-main">
        <div class="row-title">${title}</div>
        <div class="row-sub">${sub}</div>
      </div>
      ${amount != null ? `<span class="amount num ${amountClass}">${amount}</span>` : ''}
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
  const enabledModules = await getEnabledModules();
  const backupReminder = await getBackupReminderStatus();
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

  // Top expense category this month — a genuinely new detail, not shown elsewhere on this page
  const expenseByCategory = {};
  monthTxns.filter((t) => t.type === 'expense').forEach((t) => {
    const cat = t.category || 'Uncategorized';
    expenseByCategory[cat] = (expenseByCategory[cat] || 0) + t.amount;
  });
  const topCategory = Object.entries(expenseByCategory).sort((a, b) => b[1] - a[1])[0];

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

  // "Needs Attention" — consolidates things genuinely worth surfacing, only for enabled modules
  const attentionItems = [];
  if (enabledModules.recurring) {
    const upcomingRules = await getUpcomingRules(7);
    upcomingRules.forEach((r) => attentionItems.push({
      icon: icons.recurring,
      title: escapeHtml(r.name),
      sub: `Due ${formatDate(r.nextDueDate)}`,
      amount: formatCurrency(r.amount),
      href: '#/recurring',
      dueDate: r.nextDueDate,
    }));
  }
  if (nextEmi) {
    attentionItems.push({
      icon: icons.loans,
      title: `EMI · ${escapeHtml(nextEmi.loanName)}`,
      sub: `Due ${formatDate(nextEmi.dueDate)}`,
      amount: formatCurrency(nextEmi.amount),
      amountClass: 'amount--out',
      href: '#/loans',
      dueDate: nextEmi.dueDate,
    });
  }
  if (enabledModules.people) {
    for (const p of people) {
      const owedToYou = await getOutstandingLendings(p.id, 'out');
      owedToYou.filter((l) => l.remaining > 0 && (dueDateStatus(l.dueDate) === 'overdue' || dueDateStatus(l.dueDate) === 'due_today')).forEach((l) => {
        attentionItems.push({
          icon: icons.people,
          title: `${escapeHtml(p.name)} owes you`,
          sub: dueDateStatus(l.dueDate) === 'overdue' ? `Overdue since ${formatDate(l.dueDate)}` : 'Due today',
          amount: formatCurrency(l.remaining),
          amountClass: 'amount--in',
          href: `#/people?open=${p.id}`,
          dueDate: l.dueDate,
        });
      });
    }
  }
  if (enabledModules.scheduled) {
    const scheduledItems = await getScheduledTransactions();
    scheduledItems.filter((s) => daysUntil(s.scheduledDate) <= 7).forEach((s) => {
      const days = daysUntil(s.scheduledDate);
      attentionItems.push({
        icon: icons.scheduled,
        title: escapeHtml(s.description || s.category || s.type),
        sub: days < 0 ? `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}` : days === 0 ? 'Due today' : `In ${days} day${days === 1 ? '' : 's'}`,
        amount: formatCurrency(s.amount),
        amountClass: s.type === 'income' ? 'amount--in' : s.type === 'expense' ? 'amount--out' : '',
        href: '#/scheduled',
        dueDate: s.scheduledDate,
      });
    });
  }
  if (enabledModules.budgets) {
    const budgetProgress = await getBudgetProgress();
    budgetProgress.filter((b) => b.overLimit).forEach((b) => {
      attentionItems.push({
        icon: icons.budgets,
        title: `${escapeHtml(b.category)} budget exceeded`,
        sub: `${formatCurrency(b.spent)} of ${formatCurrency(b.monthlyLimit)} this month`,
        amount: formatCurrency(Math.abs(b.remaining)),
        amountClass: 'amount--out',
        href: '#/budgets',
        dueDate: new Date().toISOString(),
      });
    });
  }
  attentionItems.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  container.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Dashboard</h1>
      </div>

      ${backupReminder ? `
      <a href="#/settings" class="list-row" style="background: var(--color-warning-soft); border-radius: var(--radius-md); padding: var(--sp-3) var(--sp-4); margin-bottom: var(--sp-5); border: none;">
        <div class="row-main">
          <div class="row-title" style="color: var(--color-warning);">Backup reminder</div>
          <div class="row-sub">${backupReminder.message} Tap to back up now.</div>
        </div>
      </a>` : ''}

      <div class="grid grid-cards mb-6">
        ${statCard({ label: 'Net Worth', value: formatCurrency(netWorth), valueClass: netWorth >= 0 ? 'amount--in' : 'amount--out', sub: 'Accounts + Savings + People − Loans' })}
        ${statCard({ label: 'Total Balance', value: formatCurrency(totalBalance), sub: `${accounts.length} active account${accounts.length === 1 ? '' : 's'}`, href: '#/accounts' })}
        ${enabledModules.income ? statCard({ label: 'Income · This Month', value: formatCurrency(monthIncome), valueClass: 'amount--in', href: '#/income' }) : ''}
        ${enabledModules.expenses ? statCard({ label: 'Expenses · This Month', value: formatCurrency(monthExpense), valueClass: 'amount--out', sub: topCategory ? `Top: ${escapeHtml(topCategory[0])} (${formatCurrency(topCategory[1])})` : '', href: '#/expenses' }) : ''}
        ${(enabledModules.income || enabledModules.expenses) ? statCard({ label: 'Net Cash Flow · This Month', value: formatCurrency(monthIncome - monthExpense), valueClass: (monthIncome - monthExpense) >= 0 ? 'amount--in' : 'amount--out', sub: 'Income − Expenses (savings/transfers not included)', href: '#/reports' }) : ''}
      </div>

      ${(activeCommittees.length || loans.length || goals.length) ? `
      <div class="grid grid-cards mb-6">
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

      ${attentionItems.length ? `
      <h2 class="section-title">Needs Attention</h2>
      <div class="list mb-6">
        ${attentionItems.slice(0, 5).map((item) => attentionRow(item)).join('')}
      </div>` : ''}

      <h2 class="section-title">Recent Transactions</h2>
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
