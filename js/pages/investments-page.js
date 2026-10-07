// ==========================================================================
// Finora — pages/investments-page.js
// Investment tracking: FD, Mutual Funds, Stocks, Gold, PPF, etc.
// ==========================================================================

import { getInvestments, createInvestment, updateCurrentValue, redeemInvestment, getPortfolioSummary, INVESTMENT_TYPES, investmentTypeLabel } from '../modules/investments.js';
import { getAccounts } from '../modules/accounts.js';
import { formatCurrency } from '../utils/currency.js';
import { formatDate, escapeHtml, qs, bindRowActivation } from '../utils/dom.js';
import { icons } from '../utils/icons.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { toast } from '../core/toast.js';
import { ValidationError } from '../core/ledger.js';

import { dateInputToIso } from '../utils/date.js';
let container = null;

export async function renderInvestmentsPage(root) {
  container = root;
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Investments</h1>
        <button class="btn btn-primary" id="btn-add-investment">${icons.plus} Add Investment</button>
      </div>
      <div class="grid grid-cards mb-5" id="inv-summary"></div>
      <div class="list" id="inv-list"></div>
    </div>
  `;

  qs('#btn-add-investment', root).addEventListener('click', () => openInvestmentModal());
  await refresh();
}

async function refresh() {
  const [investments, summary] = await Promise.all([getInvestments(), getPortfolioSummary()]);

  qs('#inv-summary', container).innerHTML = `
    <div class="card stat-card">
      <span class="stat-label">Invested</span>
      <span class="amount amount--lg num">${formatCurrency(summary.totalInvested)}</span>
    </div>
    <div class="card stat-card">
      <span class="stat-label">Current Value</span>
      <span class="amount amount--lg num">${formatCurrency(summary.totalCurrentValue)}</span>
    </div>
    <div class="card stat-card">
      <span class="stat-label">Gain / Loss</span>
      <span class="amount amount--lg num ${summary.totalGain >= 0 ? 'amount--in' : 'amount--out'}">${summary.totalGain >= 0 ? '+' : ''}${formatCurrency(summary.totalGain)}</span>
      <span class="text-xs text-faint">${summary.gainPercent >= 0 ? '+' : ''}${summary.gainPercent}%</span>
    </div>
  `;

  const listEl = qs('#inv-list', container);
  if (investments.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><h3>No investments yet</h3><p>Track FDs, mutual funds, stocks, gold, and more.</p></div>`;
    return;
  }

  listEl.innerHTML = investments.map((i) => investmentRow(i)).join('');
  listEl.querySelectorAll('[data-id]').forEach((row) => {
    bindRowActivation(row, () => {
      const inv = investments.find((i) => i.id === row.dataset.id);
      openDetailModal(inv);
    });
  });
}

function investmentRow(inv) {
  const gain = inv.currentValue - inv.investedAmount;
  return `
    <div class="list-row" data-id="${inv.id}">
      <div class="row-main">
        <div class="row-title">${escapeHtml(inv.name)} ${inv.status === 'redeemed' ? '<span class="badge badge-neutral">Redeemed</span>' : ''}</div>
        <div class="row-sub">${investmentTypeLabel(inv.type)} · Invested ${formatDate(inv.investedDate)}</div>
      </div>
      <div style="text-align:right;">
        <div class="amount num">${formatCurrency(inv.currentValue)}</div>
        ${inv.status === 'active' ? `<div class="text-xs ${gain >= 0 ? 'amount--in' : 'amount--out'}">${gain >= 0 ? '+' : ''}${formatCurrency(gain)}</div>` : ''}
      </div>
    </div>
  `;
}

function openDetailModal(inv) {
  const gain = inv.currentValue - inv.investedAmount;
  const gainPercent = inv.investedAmount > 0 ? Math.round((gain / inv.investedAmount) * 1000) / 10 : 0;

  openModal({
    title: inv.name,
    bodyHtml: `
      <p class="text-sm text-muted mb-3">${investmentTypeLabel(inv.type)} · Invested ${formatDate(inv.investedDate)}${inv.maturityDate ? ` · Matures ${formatDate(inv.maturityDate)}` : ''}</p>
      <div class="summary-list">
        <div class="summary-row"><span class="summary-label">Invested</span><span class="summary-value num">${formatCurrency(inv.investedAmount)}</span></div>
        <div class="summary-row"><span class="summary-label">Current Value</span><span class="summary-value num">${formatCurrency(inv.currentValue)}</span></div>
        <div class="summary-row"><span class="summary-label">Gain / Loss</span><span class="summary-value num ${gain >= 0 ? 'amount--in' : 'amount--out'}">${gain >= 0 ? '+' : ''}${formatCurrency(gain)} (${gainPercent >= 0 ? '+' : ''}${gainPercent}%)</span></div>
      </div>
      ${inv.notes ? `<p class="text-sm text-muted">${escapeHtml(inv.notes)}</p>` : ''}
    `,
    actions: inv.status === 'active' ? [
      { label: 'Redeem', variant: 'btn-danger', onClick: (close) => { close(); openRedeemModal(inv); } },
      { label: 'Update Value', variant: 'btn-secondary', onClick: (close) => { close(); openUpdateValueModal(inv); } },
      { label: 'Close', variant: 'btn-ghost', onClick: (close) => close() },
    ] : [
      { label: 'Close', variant: 'btn-ghost', onClick: (close) => close() },
    ],
  });
}

function openUpdateValueModal(inv) {
  openModal({
    title: `Update Value · ${inv.name}`,
    bodyHtml: `
      <div class="field mb-0">
        <label for="uv-value">Current value</label>
        <input class="input" id="uv-value" type="number" min="0" step="0.01" value="${inv.currentValue}" autofocus />
        <span class="field-hint">This is informational only — it doesn't move any money.</span>
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      { label: 'Save', variant: 'btn-primary', onClick: async (close, root) => {
          try {
            await updateCurrentValue(inv.id, Number(qs('#uv-value', root).value));
            close();
            toast.success('Value updated.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Something went wrong.');
          }
        } },
    ],
  });
}

async function openRedeemModal(inv) {
  const accounts = await getAccounts();
  openModal({
    title: `Redeem · ${inv.name}`,
    bodyHtml: `
      <p class="text-sm text-muted mb-3">Marks this investment closed and adds the redeemed amount back to an account.</p>
      <div class="field">
        <label for="rd-account">Receiving account</label>
        <select class="select" id="rd-account">${accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}</select>
      </div>
      <div class="field mb-0">
        <label for="rd-amount">Amount received</label>
        <input class="input" id="rd-amount" type="number" min="0.01" step="0.01" value="${inv.currentValue}" />
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      { label: 'Redeem', variant: 'btn-danger', onClick: async (close, root) => {
          try {
            await redeemInvestment(inv.id, { accountId: qs('#rd-account', root).value, redeemAmount: Number(qs('#rd-amount', root).value) });
            close();
            toast.success('Investment redeemed.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Something went wrong.');
          }
        } },
    ],
  });
}

async function openInvestmentModal() {
  const accounts = await getAccounts();
  if (accounts.length === 0) { toast.warning('Add an account first.'); return; }

  openModal({
    title: 'Add Investment',
    bodyHtml: `
      <div class="field">
        <label for="iv-name">Name</label>
        <input class="input" id="iv-name" type="text" placeholder="e.g. HDFC Fixed Deposit" />
      </div>
      <div class="field-row">
        <div class="field">
          <label for="iv-type">Type</label>
          <select class="select" id="iv-type">${INVESTMENT_TYPES.map((t) => `<option value="${t}">${investmentTypeLabel(t)}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label for="iv-amount">Amount invested</label>
          <input class="input" id="iv-amount" type="number" min="0.01" step="0.01" />
        </div>
      </div>
      <div class="field">
        <label for="iv-account">From account</label>
        <select class="select" id="iv-account">${accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}</select>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="iv-date">Date</label>
          <input class="input" id="iv-date" type="date" />
        </div>
        <div class="field">
          <label for="iv-maturity">Maturity date (optional)</label>
          <input class="input" id="iv-maturity" type="date" />
        </div>
      </div>
      <div class="field mb-0">
        <label for="iv-notes">Notes (optional)</label>
        <input class="input" id="iv-notes" type="text" />
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      { label: 'Save', variant: 'btn-primary', onClick: async (close, root) => {
          const name = qs('#iv-name', root).value.trim();
          const type = qs('#iv-type', root).value;
          const investedAmount = Number(qs('#iv-amount', root).value);
          const accountId = qs('#iv-account', root).value;
          const dateVal = qs('#iv-date', root).value;
          const investedDate = dateInputToIso(dateVal);
          const maturityVal = qs('#iv-maturity', root).value;
          const maturityDate = dateInputToIso(maturityVal);
          const notes = qs('#iv-notes', root).value;
          try {
            await createInvestment({ name, type, investedAmount, accountId, investedDate, maturityDate, notes });
            close();
            toast.success('Investment added.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Something went wrong.');
          }
        } },
    ],
  });
}
