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
import { formatCurrency, roundMoney } from '../utils/currency.js';
import { formatDate, escapeHtml, qs, bindRowActivation, enhanceTabs } from '../utils/dom.js';
import { openModal } from '../core/modal.js';
import { getNetWorthHistory, getYearOverYearComparison, getSpendingInsights } from '../modules/insights.js';
import { icons } from '../utils/icons.js';
import { toast } from '../core/toast.js';
import { signedIncome, signedExpense, isIncomeRelated, isExpenseRelated, liveExpenses } from '../utils/ledger-math.js';

// Colour-blind-safe (Okabe-Ito family); each is >= 3:1 against both white and the dark surface.
const CHART_COLORS = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#7A5195', '#B8860B', '#6B6B6B', '#3B9AD9', '#B5359B', '#2A9D8F'];

let chartSeq = 0;

/** Every chart gets a text twin: screen readers and anyone who can't tell the colours apart can read the numbers. */
function chartDataTable(headers, rows) {
  if (!rows.length) return '';
  return `<details class="chart-data"><summary>View as table</summary><table>
    <thead><tr>${headers.map((h, i) => `<th class="${i ? 'num' : ''}">${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? 'num' : ''}">${escapeHtml(String(c))}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></details>`;
}

/** Renders a donut chart as an SVG string. data: [{label, value}], already sorted desc. */
function donutChart(data, { size = 180, thickness = 26 } = {}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total <= 0) return '';
  const r = (size - thickness) / 2;
  const cx = size / 2, cy = size / 2;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  const segments = data.slice(0, 8).map((d, i) => {
    const frac = d.value / total;
    const dash = frac * circumference;
    const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${CHART_COLORS[i % CHART_COLORS.length]}"
      stroke-width="${thickness}" stroke-dasharray="${Math.max(0, dash - 1.5)} ${circumference - Math.max(0, dash - 1.5)}"
      stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})" />`;
    offset += dash;
    return seg;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Category breakdown donut chart">${segments}</svg>`;
}

/** Renders a donut chart's legend as HTML rows matching the slice colors. */
function donutLegend(data, total) {
  return data.slice(0, 8).map((d, i) => `
    <div class="chart-legend-row">
      <span class="chart-legend-swatch" style="background:${CHART_COLORS[i % CHART_COLORS.length]};"></span>
      <span class="chart-legend-label">${escapeHtml(d.label)}</span>
      <span class="chart-legend-value num">${total > 0 ? Math.round((d.value / total) * 100) : 0}%</span>
    </div>
  `).join('') + (data.length > 8 ? `<div class="text-xs text-faint mt-2">+${data.length - 8} more category${data.length - 8 === 1 ? '' : 'ies'}</div>` : '');
}

/** Renders a grouped bar chart (income vs expense per bucket) as an SVG string. */
function trendBarChart(buckets, { width = 600, height = 200 } = {}) {
  const maxVal = Math.max(1, ...buckets.map((b) => Math.max(b.income, b.expense)));
  const padding = 28;
  const chartW = width - padding * 2;
  const chartH = height - padding;
  const n = buckets.length || 1;
  const groupW = chartW / n;
  const barW = Math.min(16, groupW / 3);

  const hatchId = `hatch-${++chartSeq}`;
  const bars = buckets.map((b, i) => {
    const groupX = padding + i * groupW + groupW / 2;
    const incomeH = (b.income / maxVal) * (chartH - 10);
    const expenseH = (b.expense / maxVal) * (chartH - 10);
    return `
      <rect x="${groupX - barW - 2}" y="${chartH - incomeH}" width="${barW}" height="${Math.max(incomeH, 0)}" fill="var(--chart-income)" rx="2" />
      <rect x="${groupX + 2}" y="${chartH - expenseH}" width="${barW}" height="${Math.max(expenseH, 0)}" fill="url(#${hatchId})" stroke="var(--chart-expense)" stroke-width="1" rx="2" />
      <text x="${groupX}" y="${height - 8}" text-anchor="middle" font-size="10" fill="var(--color-text-faint)">${escapeHtml(b.label)}</text>
    `;
  }).join('');

  const totalA = buckets.reduce((s, b) => s + b.income, 0);
  const totalB = buckets.reduce((s, b) => s + b.expense, 0);
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Bar chart of ${buckets.length} periods. First series total ${Math.round(totalA)}, second series total ${Math.round(totalB)}. A table with every value follows the chart." preserveAspectRatio="xMidYMid meet">
    <defs><pattern id="${hatchId}" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)"><rect width="5" height="5" fill="var(--chart-expense)" /><line x1="0" y1="0" x2="0" y2="5" stroke="var(--color-surface)" stroke-width="2" /></pattern></defs>
    <line x1="${padding}" y1="${chartH}" x2="${width - padding}" y2="${chartH}" stroke="var(--color-border)" stroke-width="1" />
    ${bars}
  </svg>`;
}

/** Renders a single-series line chart (e.g. net worth over time) as an SVG string. */
function lineChart(points, { width = 600, height = 220 } = {}) {
  const padding = 32;
  const chartW = width - padding * 2;
  const chartH = height - padding * 2;
  const values = points.map((p) => p.value);
  const minVal = Math.min(0, ...values);
  const maxVal = Math.max(1, ...values);
  const range = maxVal - minVal || 1;
  const n = points.length || 1;
  const stepX = n > 1 ? chartW / (n - 1) : 0;

  const coords = points.map((p, i) => {
    const x = padding + i * stepX;
    const y = padding + chartH - ((p.value - minVal) / range) * chartH;
    return { x, y, label: p.label, value: p.value };
  });

  const pathD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ');
  const zeroY = padding + chartH - ((0 - minVal) / range) * chartH;
  const areaD = `${pathD} L ${coords[coords.length - 1].x} ${zeroY} L ${coords[0].x} ${zeroY} Z`;

  const dots = coords.map((c) => `<circle cx="${c.x}" cy="${c.y}" r="3" fill="var(--color-primary)" />`).join('');
  const labels = coords.filter((_, i) => i % Math.ceil(n / 6) === 0 || i === n - 1)
    .map((c) => `<text x="${c.x}" y="${height - 6}" text-anchor="middle" font-size="10" fill="var(--color-text-faint)">${escapeHtml(c.label)}</text>`).join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Net worth history line chart" preserveAspectRatio="xMidYMid meet">
    <line x1="${padding}" y1="${zeroY}" x2="${width - padding}" y2="${zeroY}" stroke="var(--color-border)" stroke-width="1" />
    <path d="${areaD}" fill="var(--color-primary-soft)" stroke="none" />
    <path d="${pathD}" fill="none" stroke="var(--color-primary)" stroke-width="2" stroke-linejoin="round" />
    ${dots}
    ${labels}
  </svg>`;
}

/** Groups transactions into time buckets sized appropriately for the selected range. */
function buildTrendBuckets(start, end, incomeTxns, expenseTxns) {
  const rangeDays = Math.max(1, Math.round((end - start) / 86400000));
  let bucketFn, formatLabel, bucketCount;

  if (rangeDays <= 35) {
    // Daily buckets (This Month / Last Month / short custom range)
    bucketCount = rangeDays;
    bucketFn = (d) => Math.floor((d - start) / 86400000);
    formatLabel = (i) => { const d = new Date(start.getTime() + i * 86400000); return `${d.getDate()}`; };
  } else if (rangeDays <= 180) {
    // Weekly buckets
    bucketCount = Math.ceil(rangeDays / 7);
    bucketFn = (d) => Math.floor((d - start) / (7 * 86400000));
    formatLabel = (i) => `W${i + 1}`;
  } else {
    // Monthly buckets (This Year / All Time / long custom range), capped to last 24
    const months = [];
    let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor < end) { months.push(new Date(cursor)); cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1); }
    const capped = months.slice(-24);
    const offsetMonths = months.length - capped.length;
    bucketCount = capped.length;
    bucketFn = (d) => {
      const idx = (d.getFullYear() - start.getFullYear()) * 12 + (d.getMonth() - start.getMonth()) - offsetMonths;
      return idx;
    };
    formatLabel = (i) => capped[i] ? capped[i].toLocaleDateString('en-IN', { month: 'short' }) : '';
  }

  const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: formatLabel(i), income: 0, expense: 0 }));
  incomeTxns.forEach((t) => { const idx = bucketFn(new Date(t.date)); if (buckets[idx]) buckets[idx].income += signedIncome(t); });
  expenseTxns.forEach((t) => { const idx = bucketFn(new Date(t.date)); if (buckets[idx]) buckets[idx].expense += signedExpense(t); });
  buckets.forEach((b) => { b.income = Math.max(0, b.income); b.expense = Math.max(0, b.expense); });
  return buckets;
}

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
        <button class="btn btn-secondary btn-sm" id="btn-export-pdf">${icons.archive || ''} Export PDF</button>
      </div>
      <div class="print-only">
        <h2 style="margin-bottom:2px;">Finora — Financial Report</h2>
        <p class="text-sm text-muted">Generated ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}</p>
      </div>
      <div class="rpt-tab-bar" style="display:flex; border-bottom:1px solid var(--color-border); margin-bottom: var(--sp-4); overflow-x:auto;">
        <button class="btn btn-ghost btn-sm tab-btn active" data-tab="period" style="border-radius:0; border-bottom:2px solid var(--color-primary);">This Period</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="networth" style="border-radius:0;">Net Worth History</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="yoy" style="border-radius:0;">Year vs Year</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="insights" style="border-radius:0;">Insights</button>
      </div>

      <div id="tab-period" class="tab-panel">
        <div class="rpt-period-controls" style="display:flex; gap: var(--sp-3); flex-wrap:wrap; align-items:flex-end; margin-bottom: var(--sp-4);">
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
          <div class="field hidden" id="rpt-from-field" style="margin-bottom:0;">
            <label for="rpt-from">From</label>
            <input class="input" id="rpt-from" type="date" />
          </div>
          <div class="field hidden" id="rpt-to-field" style="margin-bottom:0;">
            <label for="rpt-to">To</label>
            <input class="input" id="rpt-to" type="date" />
          </div>
        </div>
        <div id="rpt-content"></div>
      </div>

      <div id="tab-networth" class="tab-panel hidden"></div>
      <div id="tab-yoy" class="tab-panel hidden"></div>
      <div id="tab-insights" class="tab-panel hidden"></div>
    </div>
  `;

  qs('#btn-export-pdf', root).addEventListener('click', () => {
    toast.success('Choose "Save as PDF" in the print dialog.');
    window.print();
  });

  root.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      root.querySelectorAll('.tab-btn').forEach((b) => { b.classList.remove('active'); b.style.borderBottom = 'none'; });
      btn.classList.add('active');
      btn.style.borderBottom = '2px solid var(--color-primary)';
      root.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      const panel = qs(`#tab-${btn.dataset.tab}`, root);
      panel.classList.remove('hidden');
      if (btn.dataset.tab === 'networth' && !panel.dataset.loaded) { await renderNetWorthTab(panel); panel.dataset.loaded = '1'; }
      if (btn.dataset.tab === 'yoy' && !panel.dataset.loaded) { await renderYoYTab(panel); panel.dataset.loaded = '1'; }
      if (btn.dataset.tab === 'insights' && !panel.dataset.loaded) { await renderInsightsTab(panel); panel.dataset.loaded = '1'; }
    });
  });

  enhanceTabs(root);

  const periodSelect = qs('#rpt-period', root);
  periodSelect.value = period;
  periodSelect.addEventListener('change', () => {
    period = periodSelect.value;
    const isCustom = period === 'custom';
    qs('#rpt-from-field', root).classList.toggle('hidden', !isCustom);
    qs('#rpt-to-field', root).classList.toggle('hidden', !isCustom);
    if (!isCustom) refresh();
  });
  qs('#rpt-from', root).addEventListener('change', (e) => { customFrom = e.target.value; if (customFrom && customTo) refresh(); });
  qs('#rpt-to', root).addEventListener('change', (e) => { customTo = e.target.value; if (customFrom && customTo) refresh(); });

  await refresh();
}

async function renderNetWorthTab(panel) {
  panel.innerHTML = `<p class="text-sm text-muted">Loading…</p>`;
  const history = await getNetWorthHistory(12);
  const latest = history[history.length - 1];
  const earliest = history[0];
  const change = latest.netWorth - earliest.netWorth;

  panel.innerHTML = `
    <div class="mb-4">
      <span class="stat-label">Net Worth Now</span><br/>
      <span class="amount amount--lg num ${latest.netWorth >= 0 ? 'amount--in' : 'amount--out'}">${formatCurrency(latest.netWorth)}</span>
    </div>
    <p class="text-sm text-muted mb-4">${change >= 0 ? 'Up' : 'Down'} ${formatCurrency(Math.abs(change))} over the last ${history.length} months</p>
    <div class="card">${lineChart(history.map((h) => ({ label: h.label, value: h.netWorth })))}
      ${chartDataTable(['Month', 'Net worth'], history.map((h) => [h.label, formatCurrency(h.netWorth)]))}</div>
    <p class="text-xs text-faint mt-2">Reconstructed from your account, savings, people, and loan history — not a stored snapshot, so it always reflects corrections and reversals.</p>
  `;
}

async function renderYoYTab(panel) {
  panel.innerHTML = `<p class="text-sm text-muted">Loading…</p>`;
  const data = await getYearOverYearComparison();
  const thisYear = new Date().getFullYear();
  const lastYear = thisYear - 1;
  const hasAnyData = data.some((m) => m.thisYearIncome || m.thisYearExpense || m.lastYearIncome || m.lastYearExpense);

  if (!hasAnyData) {
    panel.innerHTML = `<div class="empty-state"><h3>Not enough history yet</h3><p>Year-over-year comparison needs data from ${lastYear} or ${thisYear}.</p></div>`;
    return;
  }

  panel.innerHTML = `
    <p class="text-sm text-muted mb-4">Expenses: ${thisYear} vs ${lastYear}</p>
    <div class="card mb-4">${trendBarChart(data.map((m) => ({ label: m.label, income: m.thisYearExpense, expense: m.lastYearExpense })), { height: 200 })}
      ${chartDataTable(['Month', String(thisYear), String(lastYear)], data.filter((m) => m.thisYearExpense || m.lastYearExpense).map((m) => [m.label, formatCurrency(m.thisYearExpense), formatCurrency(m.lastYearExpense)]))}</div>
    <div class="flex-row mt-2 mb-4">
      <span class="chart-legend-swatch chart-legend-swatch--income"></span><span class="text-xs text-muted">${thisYear}</span>
      <span class="chart-legend-swatch chart-legend-swatch--expense" style="margin-left: var(--sp-3);"></span><span class="text-xs text-muted">${lastYear}</span>
    </div>
    <div class="list">
      ${data.filter((m) => m.thisYearExpense || m.lastYearExpense).map((m) => {
        const diff = m.thisYearExpense - m.lastYearExpense;
        const pct = m.lastYearExpense > 0 ? Math.round((diff / m.lastYearExpense) * 100) : null;
        return `
          <div class="list-row">
            <div class="row-main">
              <div class="row-title">${m.label}</div>
              <div class="row-sub">${formatCurrency(m.thisYearExpense)} vs ${formatCurrency(m.lastYearExpense)}</div>
            </div>
            ${pct != null ? `<span class="text-sm ${pct > 0 ? 'amount--out' : 'amount--in'}">${pct > 0 ? '+' : ''}${pct}%</span>` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

async function renderInsightsTab(panel) {
  panel.innerHTML = `<p class="text-sm text-muted">Loading…</p>`;
  const insights = await getSpendingInsights();

  if (insights.length === 0) {
    panel.innerHTML = `<div class="empty-state"><h3>Nothing notable yet</h3><p>Once you have at least a month of expense history, category changes will show up here.</p></div>`;
    return;
  }

  panel.innerHTML = `
    <p class="text-sm text-muted mb-4">This month vs last month, by category.</p>
    <div class="list">
      ${insights.map((i) => `
        <div class="list-row">
          <div class="row-icon">${i.type === 'increase' ? icons.expense : i.type === 'decrease' ? icons.income : icons.reports}</div>
          <div class="row-main">
            <div class="row-title">${escapeHtml(i.text)}</div>
            <div class="row-sub">${formatCurrency(i.current)} this month${i.previous ? ` · ${formatCurrency(i.previous)} last month` : ''}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

async function refresh() {
  const { start, end } = getPeriodRange();
  const [allTxns, accounts] = await Promise.all([getAll('ledger'), getAccounts({ includeArchived: true })]);
  const inRange = allTxns.filter((t) => {
    const d = new Date(t.date);
    return d >= start && d < end;
  });
  const accountsById = Object.fromEntries(accounts.map((a) => [a.id, a]));

  // Reversal/refund-aware totals (a reversed expense cancels out instead of adding).
  const incomeTxns = inRange.filter(isIncomeRelated);
  const expenseTxns = inRange.filter(isExpenseRelated);
  const totalIncome = roundMoney(incomeTxns.reduce((s, t) => s + signedIncome(t), 0));
  const totalExpense = roundMoney(expenseTxns.reduce((s, t) => s + signedExpense(t), 0));

  const byCategory = (txns, signer) => {
    const map = {};
    txns.forEach((t) => {
      const key = t.category || 'Uncategorized';
      map[key] = roundMoney((map[key] || 0) + signer(t));
    });
    return Object.entries(map).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  };

  const expenseByCategory = byCategory(expenseTxns, signedExpense);
  const incomeByCategory = byCategory(incomeTxns, signedIncome);
  // Top Expenses: only live originals (not reversed ones, not reversal/refund rows).
  const topExpenses = liveExpenses(inRange).sort((a, b) => b.amount - a.amount).slice(0, 10);
  const trendBuckets = buildTrendBuckets(start, end, incomeTxns, expenseTxns);

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
    <div class="grid grid-cards mb-6">
      <div class="card stat-card"><span class="stat-label">Total Income</span><span class="amount amount--lg num amount--in">${formatCurrency(totalIncome)}</span></div>
      <div class="card stat-card"><span class="stat-label">Total Expenses</span><span class="amount amount--lg num amount--out">${formatCurrency(totalExpense)}</span></div>
      <div class="card stat-card"><span class="stat-label">Net</span><span class="amount amount--lg num ${totalIncome - totalExpense >= 0 ? 'amount--in' : 'amount--out'}">${formatCurrency(totalIncome - totalExpense)}</span></div>
    </div>

    ${(totalIncome > 0 || totalExpense > 0) ? `
    <h2 class="section-title">Income vs Expense Trend</h2>
    <div class="card mb-6">
      ${trendBarChart(trendBuckets)}
      ${chartDataTable(['Period', 'Income', 'Expense'], trendBuckets.filter((b) => b.income || b.expense).map((b) => [b.label, formatCurrency(b.income), formatCurrency(b.expense)]))}
      <div class="flex-row mt-2">
        <span class="chart-legend-swatch chart-legend-swatch--income"></span><span class="text-xs text-muted">Income</span>
        <span class="chart-legend-swatch chart-legend-swatch--expense" style="margin-left: var(--sp-3);"></span><span class="text-xs text-muted">Expense</span>
      </div>
    </div>` : ''}

    <h2 class="section-title">Expense Breakdown</h2>
    ${expenseByCategory.length ? `
    <div class="card mb-3 flex-row" style="align-items:flex-start; flex-wrap:wrap; gap: var(--sp-5);">
      ${donutChart(expenseByCategory.map(([label, value]) => ({ label, value })))}
      <div style="flex:1; min-width:160px;">${donutLegend(expenseByCategory.map(([label, value]) => ({ label, value })), totalExpense)}</div>
    </div>` : ''}
    <div class="list mb-6" id="rpt-expense-cats">
      ${expenseByCategory.length ? expenseByCategory.map(([cat, amt]) => breakdownRow(cat, amt, totalExpense, 'out')).join('') : emptyRow('No expenses in this period.')}
    </div>

    <h2 class="section-title">Income Breakdown</h2>
    ${incomeByCategory.length ? `
    <div class="card mb-3 flex-row" style="align-items:flex-start; flex-wrap:wrap; gap: var(--sp-5);">
      ${donutChart(incomeByCategory.map(([label, value]) => ({ label, value })))}
      <div style="flex:1; min-width:160px;">${donutLegend(incomeByCategory.map(([label, value]) => ({ label, value })), totalIncome)}</div>
    </div>` : ''}
    <div class="list mb-6" id="rpt-income-cats">
      ${incomeByCategory.length ? incomeByCategory.map(([cat, amt]) => breakdownRow(cat, amt, totalIncome, 'in')).join('') : emptyRow('No income in this period.')}
    </div>

    <h2 class="section-title">Top Expenses</h2>
    <div class="list mb-6" id="rpt-top-expenses">
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

    <h2 class="section-title">Account Activity</h2>
    <div class="list mb-6" id="rpt-account-activity">
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
      <h2 class="section-title">Other Activity</h2>
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
      <div class="text-sm flex-col">
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
