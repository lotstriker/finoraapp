// ==========================================================================
// Finora — pages/transfers-page.js
// ==========================================================================

import { getAccounts, getAccountById } from '../modules/accounts.js';
import { createTransfer, getTransferEntries } from '../modules/transfers.js';
import { getSetting } from '../modules/preferences.js';
import { ValidationError } from '../core/ledger.js';
import { formatCurrency } from '../utils/currency.js';
import { formatDate, escapeHtml, qs, consumeAddParam } from '../utils/dom.js';
import { icons } from '../utils/icons.js';
import { openModal } from '../core/modal.js';
import { toast } from '../core/toast.js';

import { todayLocal, dateInputToIso } from '../utils/date.js';
let container = null;

export async function renderTransfersPage(root, params) {
  container = root;
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Transfers</h1>
        <button class="btn btn-primary" id="btn-add-transfer">${icons.plus} Add Transfer</button>
      </div>
      <div class="list" id="transfer-list"></div>
    </div>
  `;
  qs('#btn-add-transfer', root).addEventListener('click', () => openAddTransferModal());
  await refresh();
  if (consumeAddParam(params, 'transfers')) await openAddTransferModal();
}

async function refresh() {
  const [entries, accounts] = await Promise.all([getTransferEntries(), getAccounts({ includeArchived: true })]);
  const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
  const listEl = qs('#transfer-list', container);

  if (entries.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><h3>No transfers yet</h3><p>Move money between your own accounts here.</p></div>`;
    return;
  }

  listEl.innerHTML = entries.map((t) => `
    <div class="list-row">
      <div class="row-icon">${icons.transfer}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(byId[t.accountId]?.name || '—')} → ${escapeHtml(byId[t.toAccountId]?.name || '—')}</div>
        <div class="row-sub">${escapeHtml(t.description || '')} · ${formatDate(t.date)}</div>
      </div>
      <span class="amount num amount--transfer">${formatCurrency(t.amount)}</span>
    </div>
  `).join('');
}

export async function openAddTransferModal(preselectFromId, onSuccess) {
  const accounts = await getAccounts();
  if (accounts.length < 2) {
    toast.warning('You need at least two accounts to make a transfer.');
    return;
  }
  const options = accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  const defaultAccountId = preselectFromId || await getSetting('defaultAccountId');

  openModal({
    title: 'Add Transfer',
    bodyHtml: `
      <form id="form-transfer">
        <div class="field-row">
          <div class="field">
            <label for="tr-from">From</label>
            <select class="select" id="tr-from">${options}</select>
          </div>
          <div class="field">
            <label for="tr-to">To</label>
            <select class="select" id="tr-to">${options}</select>
          </div>
        </div>
        <div class="field">
          <label for="tr-amount">Amount</label>
          <input class="input" id="tr-amount" type="number" min="0.01" step="0.01" required />
        </div>
        <div class="field">
          <label for="tr-desc">Description (optional)</label>
          <input class="input" id="tr-desc" type="text" placeholder="e.g. Move to savings account" />
        </div>
        <div class="field">
          <label for="tr-date">Date</label>
          <input class="input" id="tr-date" type="date" value="${todayLocal()}" />
        </div>
      </form>
    `,
    onMount: (root) => {
      if (defaultAccountId) qs('#tr-from', root).value = defaultAccountId;
      // Default "To" to a different account so From/To aren't the same by default
      const toSelect = qs('#tr-to', root);
      const fromValue = qs('#tr-from', root).value;
      const differentIdx = accounts.findIndex((a) => a.id !== fromValue);
      toSelect.selectedIndex = differentIdx >= 0 ? differentIdx : Math.min(1, accounts.length - 1);
    },
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Add Transfer',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const fromAccountId = qs('#tr-from', root).value;
          const toAccountId = qs('#tr-to', root).value;
          const amount = Number(qs('#tr-amount', root).value);
          const description = qs('#tr-desc', root).value;
          const date = dateInputToIso(qs('#tr-date', root).value);

          try {
            await createTransfer({ fromAccountId, toAccountId, amount, description, date });
            close();
            toast.success('Transfer completed.');
            if (container) refresh();
            if (onSuccess) onSuccess();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Something went wrong with the transfer.');
          }
        },
      },
    ],
  });
}
