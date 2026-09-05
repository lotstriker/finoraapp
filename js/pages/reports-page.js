// ==========================================================================
// Finora — pages/reports-page.js
// "Reports support a selected date period. Default: Current Month" (18).
// Drill-down: summary → list → transaction.
//
// Second-opinion-review fixes: Top Expenses / Account Activity rows are now
// clickable (drill-down), and Transfers/Savings/Bid & Save/Loan EMI/Person
// transaction types now get their own section instead of only Income/Expense.
// ==========================================================================

import { getAll } from '../core/db.js';
import { getAccounts } from '../modules/accounts.js';
import { formatCurrency } from '../utils/currency.js';
import { formatDate, escapeHtml, qs, bindRowActivation } from '../utils/dom.js';
import { openModal } from '../core/modal.js';

let container = null;
let period = 'this_month';
let customFrom = null;
let customTo = null;

function getPeriodRange() {
  const now = new Date();
  let start, end;
  if (period === 'this_month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  } else if (period === 'last_month') {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (period === 'this_year') {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now.getFullYear() + 1, 0, 1);
  } else if (period === 'all_time') {
    start = new Date(0);
    end = new Date(now.getFullYear() + 1, 0, 1);
  } else if (period === 'custom' && customFrom && customTo) {
    start = new Date(customFrom);
    end = new Date(new Date(customTo).getTime() + 86400000);
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }
  return { start, end };
}

export async function renderReportsPage(root) {
  container = root;
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Reports</h1>
      </div>
      <div style="display:flex; gap: var(--sp-3); flex-wrap:wrap; align-items:flex-end; margin-bottom: var(--sp-4);">
        <div class="field" style="min-width:180px; margin-bottom:0;">
          <label for="rpt-period">Period</label>
          <select class="select" id="rpt-period">
            <option value="this_month">This Month</option>
            <option value="last_month">Last Month</option>
            <option value="this_year">This Year</option>
            <option value="all_time">All Time</option>
            <option value="custom">Custom Range</option>
          </select>
        </div>
        <div class="field" id="rpt-from-field" style="display:none; margin-bottom:0;">
          <label for="rpt-from">From</label>
          <input class="input" id="rpt-from" type="date" />
        </div>
        <div class="field" id="rpt-to-field" style="display:none; margin-bottom:0;">
          <label for="rpt-to">To</label>
          <input class="input" id="rpt-to" type="date" />
        </div>
      </div>
      <div id="rpt-content"></div>
    </div>
  `;

  const periodSelect = qs('#rpt-period', root);
  periodSelect.value = period;
  periodSelect.addEventListener('change', () => {
    period = periodSelect.value;
    const isCustom = period === 'custom';
    qs('#rpt-from-field', root).style.display = isCustom ? '' : 'none';
    qs('#rpt-to-field', root).style.display = isCustom ? '' : 'none';
    if (!isCustom) refresh();
  });
  qs('#rpt-from', root).addEventListener('change', (e) => { customFrom = e.target.value; if (customFrom && customTo) refresh(); });
  qs('#rpt-to', root).addEventListener('change', (e) => { customTo = e.target.value; if (customFrom && customTo) refresh(); });

  await refresh();
}

async function refresh() {
  const { start, end } = getPeriodRange();
  const [allTxns, accounts] = await Promise.all([getAll('ledger'), getAccounts({ includeArchived: true })]);
  const inRange = allTxns.filter((t) => {
    const d = new Date(t.date);
    return d >= start && d < end;
  });
  const accountsById = Object.fromEntries(accounts.map((a) => [a.id, a]));

  const incomeTxns = inRange.filter((t) => t.type === 'income');
  const expenseTxns = inRange.filter((t) => t.type === 'expense');
  const totalIncome = incomeTxns.reduce((s, t) => s + t.amount, 0);
  const totalExpense = expenseTxns.reduce((s, t) => s + t.amount, 0);

  const byCategory = (txns) => {
    const map = {};
    txns.forEach((t) => {
      const key = t.category || 'Uncategorized';
      map[key] = (map[key] || 0) + t.amount;
    });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  };

  const expenseByCategory = byCategory(expenseTxns);
  const incomeByCategory = byCategory(incomeTxns);
  const topExpenses = [...expenseTxns].sort((a, b) => b.amount - a.amount).slice(0, 10);

  const accountActivity = accounts.map((a) => {
    const relevant = inRange.filter((t) => t.accountId === a.id || t.toAccountId === a.id);
    let inAmt = 0, outAmt = 0;
    relevant.forEach((t) => {
      if (t.accountId === a.id) { if (t.direction === 'out' || t.direction === 'transfer') outAmt += t.amount; if (t.direction === 'in') inAmt += t.amount; }
      if (t.toAccountId === a.id && t.direction === 'transfer') inAmt += t.amount;
    });
    return { account: a, inAmt, outAmt, net: inAmt - outAmt, txns: relevant };
  }).filter((row) => row.inAmt > 0 || row.outAmt > 0);

  // Other transaction types — previously invisible in Reports entirely.
  const otherGroups = [
    { key: 'transfer', label: 'Transfers', txns: inRange.filter((t) => t.type === 'transfer') },
    { key: 'savings_contribution', label: 'Savings Contributions (not an expense)', txns: inRange.filter((t) => t.type === 'savings_contribution') },
    { key: 'savings_withdrawal', label: 'Savings Withdrawals (not income)', txns: inRange.filter((t) => t.type === 'savings_withdrawal') },
    { key: 'committee_payment', label: 'Bid & Save Contributions', txns: inRange.filter((t) => t.type === 'committee_payment') },
    { key: 'committee_payout', label: 'Bid & Save Payouts', txns: inRange.filter((t) => t.type === 'committee_payout') },
    { key: 'loan_emi', label: 'Loan EMI Payments', txns: inRange.filter((t) => t.type === 'loan_emi') },
    { key: 'person_lending', label: 'Money Lent / Borrowed', txns: inRange.filter((t) => t.type === 'person_lending') },
    { key: 'person_repayment', label: 'Person Repayments', txns: inRange.filter((t) => t.type === 'person_repayment') },
  ].filter((g) => g.txns.length > 0);

  const el = qs('#rpt-content', container);
  el.innerHTML = `
    <div class="grid grid-cards" style="margin-bottom: var(--sp-6);">
      <div class="card stat-card"><span class="stat-label">Total Income</span><span class="amount amount--lg num amount--in">${formatCurrency(totalIncome)}</span></div>
      <div class="card stat-card"><span class="stat-label">Total Expenses</span><span class="amount amount--lg num amount--out">${formatCurrency(totalExpense)}</span></div>
      <div class="card stat-card"><span class="stat-label">Net</span><span class="amount amount--lg num ${totalIncome - totalExpense >= 0 ? 'amount--in' : 'amount--out'}">${formatCurrency(totalIncome - totalExpense)}</span></div>
    </div>

    <h2 style="font-size: var(--fs-md); font-weight: 650; margin-bottom: var(--sp-3);">Expense Breakdown</h2>
    <div class="list" id="rpt-expense-cats" style="margin-bottom: var(--sp-6);">
      ${expenseByCategory.length ? expenseByCategory.map(([cat, amt]) => breakdownRow(cat, amt, totalExpense, 'out')).join('') : emptyRow('No expenses in this period.')}
    </div>

    <h2 style="font-size: var(--fs-md); font-weight: 650; margin-bottom: var(--sp-3);">Income Breakdown</h2>
    <div class="list" id="rpt-income-cats" style="margin-bottom: var(--sp-6);">
      ${incomeByCategory.length ? incomeByCategory.map(([cat, amt]) => breakdownRow(cat, amt, totalIncome, 'in')).join('') : emptyRow('No income in this period.')}
    </div>

    <h2 style="font-size: var(--fs-md); font-weight: 650; margin-bottom: var(--sp-3);">Top Expenses</h2>
    <div class="list" id="rpt-top-expenses" style="margin-bottom: var(--sp-6);">
      ${topExpenses.length ? topExpenses.map((t, i) => `
        <div class="list-row is-clickable" data-txn-idx="${i}">
          <div class="row-main">
            <div class="row-title">${escapeHtml(t.description || t.category)}</div>
            <div class="row-sub">${escapeHtml(t.category || '')} · ${formatDate(t.date)}</div>
          </div>
          <span class="amount num amount--out">${formatCurrency(t.amount)}</span>
        </div>
      `).join('') : emptyRow('No expenses in this period.')}
    </div>

    <h2 style="font-size: var(--fs-md); font-weight: 650; margin-bottom: var(--sp-3);">Account Activity</h2>
    <div class="list" id="rpt-account-activity" style="margin-bottom: var(--sp-6);">
      ${accountActivity.length ? accountActivity.map((row, i) => `
        <div class="list-row is-clickable" data-acc-idx="${i}">
          <div class="row-main">
            <div class="row-title">${escapeHtml(row.account.name)}</div>
            <div class="row-sub">In ${formatCurrency(row.inAmt)} · Out ${formatCurrency(row.outAmt)}</div>
          </div>
          <div class="row-trail">
            <span class="amount num ${row.net >= 0 ? 'amount--in' : 'amount--out'}">${formatCurrency(row.net)}</span>
          </div>
        </div>
      `).join('') : emptyRow('No account activity in this period.')}
    </div>

    ${otherGroups.length ? `
      <h2 style="font-size: var(--fs-md); font-weight: 650; margin-bottom: var(--sp-3);">Other Activity</h2>
      <div class="list" id="rpt-other-groups">
        ${otherGroups.map((g, i) => `
          <div class="list-row is-clickable" data-group-idx="${i}">
            <div class="row-main">
              <div class="row-title">${g.label}</div>
              <div class="row-sub">${g.txns.length} transaction${g.txns.length === 1 ? '' : 's'}</div>
            </div>
            <span class="amount num">${formatCurrency(g.txns.reduce((s, t) => s + t.amount, 0))}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;

  el.querySelectorAll('[data-cat]').forEach((row) => {
    bindRowActivation(row, () => openCategoryDrilldown(row.dataset.cat, row.dataset.type === 'in' ? incomeTxns : expenseTxns, accountsById));
  });
  el.querySelectorAll('[data-txn-idx]').forEach((row) => {
    bindRowActivation(row, () => openTransactionDetail(topExpenses[Number(row.dataset.txnIdx)], accountsById));
  });
  el.querySelectorAll('[data-acc-idx]').forEach((row) => {
    bindRowActivation(row, () => openAccountActivityDrilldown(accountActivity[Number(row.dataset.accIdx)], accountsById));
  });
  el.querySelectorAll('[data-group-idx]').forEach((row) => {
    const group = otherGroups[Number(row.dataset.groupIdx)];
    bindRowActivation(row, () => openTransactionListModal(group.label, group.txns, accountsById));
  });
}

function breakdownRow(category, amount, total, dir) {
  const pct = total > 0 ? Math.round((amount / total) * 100) : 0;
  return `
    <div class="list-row is-clickable" data-cat="${escapeHtml(category)}" data-type="${dir}">
      <div class="row-main">
        <div class="row-title">${escapeHtml(category)}</div>
        <div class="progress-track" style="margin-top:6px; max-width:200px;"><div class="progress-fill" style="width:${pct}%;"></div></div>
      </div>
      <div class="row-trail">
        <span class="text-xs text-faint">${pct}%</span>
        <span class="amount num amount--${dir}">${formatCurrency(amount)}</span>
      </div>
    </div>
  `;
}

function emptyRow(text) {
  return `<div class="empty-state"><p>${text}</p></div>`;
}

function openCategoryDrilldown(category, txns, accountsById) {
  const filtered = txns.filter((t) => (t.category || 'Uncategorized') === category);
  openTransactionListModal(category, filtered, accountsById);
}

function openAccountActivityDrilldown(row, accountsById) {
  openTransactionListModal(row.account.name, row.txns, accountsById);
}

function openTransactionListModal(title, txns, accountsById) {
  const rows = txns.map((t) => `
    <div class="list-row">
      <div class="row-main">
        <div class="row-title">${escapeHtml(t.description || t.type)}</div>
        <div class="row-sub">${escapeHtml(accountsById[t.accountId]?.name || '—')} · ${formatDate(t.date)}</div>
      </div>
      <span class="amount num amount--${t.direction === 'transfer' ? 'transfer' : t.direction}">${formatCurrency(t.amount)}</span>
    </div>
  `).join('');

  openModal({
    title,
    size: 'md',
    bodyHtml: `<div class="list">${rows || '<div class="empty-state"><p>Nothing here.</p></div>'}</div>`,
    actions: [{ label: 'Close', variant: 'btn-ghost', onClick: (close) => close() }],
  });
}

function openTransactionDetail(t, accountsById) {
  openModal({
    title: t.description || t.type,
    bodyHtml: `
      <div class="text-sm" style="display:flex; flex-direction:column; gap: var(--sp-2);">
        <div><span class="text-muted">Amount</span><br/><span class="amount num">${formatCurrency(t.amount)}</span></div>
        <div><span class="text-muted">Account</span><br/>${escapeHtml(accountsById[t.accountId]?.name || '—')}</div>
        ${t.category ? `<div><span class="text-muted">Category</span><br/>${escapeHtml(t.category)}</div>` : ''}
        <div><span class="text-muted">Date</span><br/>${formatDate(t.date)}</div>
        <div><span class="text-muted">Reference</span><br/><span class="text-xs text-faint">${t.id}</span></div>
      </div>
    `,
    actions: [{ label: 'View in Transactions', variant: 'btn-primary', onClick: (close) => { close(); location.hash = '#/transactions'; } }],
  });
}
