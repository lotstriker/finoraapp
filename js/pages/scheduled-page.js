// ==========================================================================
// Finora — pages/scheduled-page.js
// Plan one-time future transactions ahead of when they actually happen.
// ==========================================================================

import { getScheduledTransactions, createScheduled, recordScheduled, skipScheduled, deleteScheduled, daysUntil } from '../modules/scheduled.js';
import { getAccounts } from '../modules/accounts.js';
import { getCategories } from '../modules/categories.js';
import { formatCurrency } from '../utils/currency.js';
import { formatDate, escapeHtml, qs, bindRowActivation } from '../utils/dom.js';
import { icons } from '../utils/icons.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { toast } from '../core/toast.js';
import { ValidationError } from '../core/ledger.js';

let container = null;

export async function renderScheduledPage(root) {
  container = root;
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <h1>Scheduled</h1>
          <p class="page-subtitle">One-time future transactions you're planning ahead — recorded only when you say so.</p>
        </div>
        <button class="btn btn-primary" id="btn-add-scheduled">${icons.plus} Plan a Transaction</button>
      </div>
      <div class="list" id="scheduled-list"></div>
    </div>
  `;

  qs('#btn-add-scheduled', root).addEventListener('click', () => openScheduledModal());
  await refresh();
}

async function refresh() {
  const items = await getScheduledTransactions();
  const listEl = qs('#scheduled-list', container);

  if (items.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><h3>Nothing scheduled</h3><p>Plan a one-time future income, expense, or transfer.</p></div>`;
    return;
  }

  listEl.innerHTML = items.map((s) => scheduledRow(s)).join('');
  listEl.querySelectorAll('[data-id]').forEach((row) => {
    bindRowActivation(row, () => {
      const item = items.find((i) => i.id === row.dataset.id);
      openActionsModal(item);
    });
  });
}

function scheduledRow(s) {
  const days = daysUntil(s.scheduledDate);
  const dueLabel = days < 0 ? `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}` : days === 0 ? 'Due today' : `In ${days} day${days === 1 ? '' : 's'}`;
  const badgeClass = days < 0 ? 'badge-danger' : days <= 2 ? 'badge-warning' : 'badge-neutral';
  const icon = s.type === 'income' ? icons.income : s.type === 'expense' ? icons.expense : icons.transfer;
  return `
    <div class="list-row" data-id="${s.id}">
      <div class="row-icon">${icon}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(s.description || s.category || s.type)}</div>
        <div class="row-sub">${formatDate(s.scheduledDate)} · <span class="badge ${badgeClass}">${dueLabel}</span></div>
      </div>
      <span class="amount num ${s.type === 'income' ? 'amount--in' : s.type === 'expense' ? 'amount--out' : ''}">${formatCurrency(s.amount)}</span>
    </div>
  `;
}

async function openActionsModal(item) {
  openModal({
    title: escapeHtml(item.description || item.category || item.type),
    bodyHtml: `
      <p class="text-sm text-muted mb-0">Scheduled for ${formatDate(item.scheduledDate)} · ${formatCurrency(item.amount)}</p>
    `,
    actions: [
      { label: 'Delete', variant: 'btn-danger', onClick: async (close) => {
          const ok = await confirmDialog({ title: 'Delete', message: 'Remove this scheduled transaction?' });
          if (ok) { await deleteScheduled(item.id); close(); toast.success('Deleted.'); refresh(); }
        } },
      { label: 'Skip', variant: 'btn-secondary', onClick: async (close) => {
          await skipScheduled(item.id);
          close();
          toast.success('Skipped — no transaction was recorded.');
          refresh();
        } },
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      { label: 'Record Now', variant: 'btn-primary', onClick: async (close) => {
          try {
            await recordScheduled(item.id);
            close();
            toast.success('Recorded.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Something went wrong.');
          }
        } },
    ],
  });
}

async function openScheduledModal() {
  const accounts = await getAccounts();
  if (accounts.length === 0) {
    toast.warning('Add an account first.');
    return;
  }
  const [incomeCats, expenseCats] = await Promise.all([getCategories('income'), getCategories('expense')]);
  const accountOptions = accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');

  openModal({
    title: 'Plan a Transaction',
    bodyHtml: `
      <div class="field">
        <label for="sc-type">Type</label>
        <select class="select" id="sc-type">
          <option value="income">Income</option>
          <option value="expense">Expense</option>
          <option value="transfer">Transfer</option>
        </select>
      </div>
      <div class="field">
        <label for="sc-date">Date</label>
        <input class="input" id="sc-date" type="date" />
      </div>
      <div class="field">
        <label for="sc-amount">Amount</label>
        <input class="input" id="sc-amount" type="number" min="0.01" step="0.01" />
      </div>
      <div class="field" id="sc-account-field">
        <label for="sc-account">Account</label>
        <select class="select" id="sc-account">${accountOptions}</select>
      </div>
      <div class="field hidden" id="sc-to-account-field">
        <label for="sc-to-account">To Account</label>
        <select class="select" id="sc-to-account">${accountOptions}</select>
      </div>
      <div class="field" id="sc-category-field">
        <label for="sc-category">Category</label>
        <select class="select" id="sc-category">${incomeCats.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('')}</select>
      </div>
      <div class="field mb-0">
        <label for="sc-desc">Description (optional)</label>
        <input class="input" id="sc-desc" type="text" />
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Save',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const type = qs('#sc-type', root).value;
          const scheduledDateVal = qs('#sc-date', root).value;
          const scheduledDate = scheduledDateVal ? new Date(scheduledDateVal).toISOString() : '';
          const amount = Number(qs('#sc-amount', root).value);
          const accountId = qs('#sc-account', root).value;
          const toAccountId = type === 'transfer' ? qs('#sc-to-account', root).value : undefined;
          const category = type !== 'transfer' ? qs('#sc-category', root).value : undefined;
          const description = qs('#sc-desc', root).value;
          try {
            await createScheduled({ type, scheduledDate, amount, accountId, toAccountId, category, description });
            close();
            toast.success('Scheduled.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Something went wrong.');
          }
        },
      },
    ],
    onMount: (root) => {
      const typeSelect = qs('#sc-type', root);
      const categorySelect = qs('#sc-category', root);
      const sync = () => {
        const type = typeSelect.value;
        qs('#sc-to-account-field', root).classList.toggle('hidden', type !== 'transfer');
        qs('#sc-category-field', root).classList.toggle('hidden', type === 'transfer');
        if (type !== 'transfer') {
          const cats = type === 'income' ? incomeCats : expenseCats;
          categorySelect.innerHTML = cats.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
        }
      };
      typeSelect.addEventListener('change', sync);
      sync();
    },
  });
}
