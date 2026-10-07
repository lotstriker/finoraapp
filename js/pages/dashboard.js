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
import { getRecentTransactions, getLedgerBetween } from '../core/ledger.js';
import { getNetWorthHistory } from '../modules/insights.js';
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
import { signedIncome, signedExpense, isExpenseRelated } from '../utils/ledger-math.js';
import { roundMoney } from '../utils/currency.js';

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
  const now = new Date();
  const monthStartIso = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const nextMonthIso = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
  const [accounts, recent, allTxns, committees, loans, goals, people] = await Promise.all([
    getAccounts(),
    getRecentTransactions(6),
    getLedgerBetween(monthStartIso, nextMonthIso),   // this month only (index range), not the whole ledger
    getCommittees(),
    getLoans({ includeClosed: false }),
    getGoals(),
    getPeople(),
  ]);

  const totalBalance = accounts.reduce((sum, a) => sum + (a.balance || 0), 0);
  const accountsById = Object.fromEntries(accounts.map((a) => [a.id, a]));

  const monthTxns = allTxns.filter((t) => isThisMonth(t.date));
  // Reversal/refund-aware: a reversed expense must REDUCE expenses, not add to them.
  const monthIncome = roundMoney(monthTxns.reduce((s, t) => s + signedIncome(t), 0));
  const monthExpense = roundMoney(monthTxns.reduce((s, t) => s + signedExpense(t), 0));

  // Top expense category this month — a genuinely new detail, not shown elsewhere on this page
  const expenseByCategory = {};
  monthTxns.filter(isExpenseRelated).forEach((t) => {
    const cat = t.category || 'Uncategorized';
    expenseByCategory[cat] = roundMoney((expenseByCategory[cat] || 0) + signedExpense(t));
  });
  const topCategory = Object.entries(expenseByCategory).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0];

  // Net Worth = accounts + savings goals + people receivable (signed) - loans outstanding
  const totalSavings = goals.reduce((s, g) => s + (g.currentAmount || 0), 0);
  const totalPeopleNet = people.reduce((s, p) => s + (p.balance || 0), 0);
  let totalLoansOutstanding = 0; // still to pay (shown on the Loans card)
  let totalLoanPrincipal = 0;    // actually owed today (used for net worth)
  for (const loan of loans) {
    const installments = await getInstallments(loan.id);
    const lp = loanProgress(installments);
    totalLoansOutstanding += lp.remainingAmount;
    totalLoanPrincipal += lp.remainingPrincipal;
  }
  const netWorth = roundMoney(totalBalance + totalSavings + totalPeopleNet - totalLoanPrincipal);

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

  // Budget health: most-used budgets first. Always shows the % as TEXT too (not colour alone).
  const budgetHealth = enabledModules.budgets
    ? (await getBudgetProgress()).filter((b) => b.monthlyLimit > 0)
        .map((b) => ({ ...b, pct: Math.round((b.spent / b.monthlyLimit) * 100) }))
        .sort((a, b) => b.pct - a.pct).slice(0, 4)
    : [];

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

      <div class="card net-worth-hero mb-4">
        <div class="net-worth-hero-main">
          <span class="stat-label">Net Worth</span>
          <span class="amount amount--xl num ${netWorth >= 0 ? 'amount--in' : 'amount--out'}">${formatCurrency(netWorth)}</span>
          <span class="text-xs text-faint">Accounts + Savings + People − Loans owed</span>
          <span class="text-sm" id="nw-delta" aria-live="polite"></span>
        </div>
        <div class="net-worth-hero-chart" id="nw-spark" aria-hidden="true"></div>
      </div>

      <div class="grid grid-cards mb-6">
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

      ${budgetHealth.length ? `
      <h2 class="section-title">Budget Health</h2>
      <a href="#/budgets" class="card budget-health mb-6">
        ${budgetHealth.map((b) => `
          <div class="budget-health-row">
            <div class="budget-health-top"><span>${escapeHtml(b.category)}</span><span class="num ${b.overLimit ? 'amount--out' : ''}">${b.overLimit ? `Over by ${formatCurrency(Math.abs(b.remaining))}` : `${b.pct}% used`}</span></div>
            <div class="budget-health-bar" role="progressbar" aria-label="${escapeHtml(b.category)} budget" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, b.pct)}"><span class="${b.overLimit ? 'is-over' : b.pct >= 80 ? 'is-warn' : ''}" style="width:${Math.min(100, b.pct)}%"></span></div>
          </div>`).join('')}
      </a>` : ''}

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

  // Net-worth trend loads AFTER the page is on screen (it replays the ledger, so it must not delay first paint).
  getNetWorthHistory(6).then((history) => {
    const spark = container.querySelector('#nw-spark');
    const delta = container.querySelector('#nw-delta');
    if (!spark || history.length < 2) return;
    spark.innerHTML = sparkline(history.map((h) => h.netWorth));
    const change = roundMoney(history[history.length - 1].netWorth - history[history.length - 2].netWorth);
    if (delta && change !== 0) {
      delta.className = `text-sm amount--${change > 0 ? 'in' : 'out'}`;
      delta.textContent = `${change > 0 ? '▲' : '▼'} ${formatCurrency(Math.abs(change))} vs last month`;
    }
  }).catch(() => { /* the trend is a bonus; the dashboard works without it */ });
}

/** Tiny dependency-free trend line (SVG). `values` oldest -> newest. */
export function sparkline(values, { width = 220, height = 56 } = {}) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 4;
  const pts = values.map((v, i) => [
    pad + (i * (width - pad * 2)) / (values.length - 1),
    height - pad - ((v - min) / span) * (height - pad * 2),
  ]);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" focusable="false">
    <polyline points="${line}" fill="none" stroke="var(--color-primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.5" fill="var(--color-primary)" />
  </svg>`;
}
