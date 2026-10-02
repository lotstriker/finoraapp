// ==========================================================================
// Finora — pages/expenses-page.js
// ==========================================================================

import { getAccounts, accountTypeLabel } from '../modules/accounts.js';
import { getCategories, createCategory } from '../modules/categories.js';
import { createExpense, getExpenseEntries } from '../modules/expenses.js';
import { getSetting } from '../modules/preferences.js';
import { ValidationError, CreditLimitExceededError } from '../core/ledger.js';
import { formatCurrency } from '../utils/currency.js';
import { formatDate, escapeHtml, qs, renderPagination as renderPaginationUI } from '../utils/dom.js';
import { icons } from '../utils/icons.js';
import { openModal } from '../core/modal.js';
import { toast } from '../core/toast.js';
import { readFileAsAttachment } from '../utils/attachment.js';

let container = null;
let searchTerm = '';
let page = 1;
const PAGE_SIZE = 10;

export async function renderExpensesPage(root) {
  container = root;
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <h1>Expenses</h1>
          <p class="page-subtitle">Record and review expense transactions.</p>
        </div>
        <button class="btn btn-primary" id="btn-add-expense">${icons.plus} Add Expense</button>
      </div>
      <div class="field" style="max-width:320px;">
        <input class="input" id="expense-search" type="text" placeholder="Search description or category" />
      </div>
      <div class="list mt-3" id="expense-list"></div>
      <div id="expense-pagination" style="display:flex; justify-content:center; gap: var(--sp-2); margin-top: var(--sp-4);"></div>
    </div>
  `;

  qs('#btn-add-expense', root).addEventListener('click', openAddExpenseModal);
  qs('#expense-search', root).addEventListener('input', (e) => {
    searchTerm = e.target.value.toLowerCase();
    page = 1;
    refresh();
  });

  await refresh();
}

async function refresh() {
  const entries = await getExpenseEntries();
  const filtered = searchTerm
    ? entries.filter((e) => (e.description || '').toLowerCase().includes(searchTerm) || (e.category || '').toLowerCase().includes(searchTerm))
    : entries;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  page = Math.min(page, totalPages);
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const listEl = qs('#expense-list', container);
  if (pageItems.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><h3>No expenses recorded</h3><p>Add your first expense to see it here.</p></div>`;
  } else {
    listEl.innerHTML = pageItems.map((t) => `
      <div class="list-row">
        <div class="row-icon">${icons.expense}</div>
        <div class="row-main">
          <div class="row-title">${escapeHtml(t.description || t.category)}</div>
          <div class="row-sub">${escapeHtml(t.category || '')} · ${formatDate(t.date)}${t.status === 'insufficient_balance' ? ' · <span class="badge badge-warning">Insufficient balance</span>' : ''}</div>
        </div>
        <span class="amount num amount--out">-${formatCurrency(t.amount)}</span>
      </div>
    `).join('');
  }

  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  renderPaginationUI(qs('#expense-pagination', container), page, totalPages, (newPage) => { page = newPage; refresh(); });
}

async function openAddExpenseModal() {
  const [accounts, categories] = await Promise.all([getAccounts(), getCategories('expense')]);

  if (accounts.length === 0) {
    toast.warning('Add an account first before recording an expense.');
    return;
  }

  const accountOptions = accounts.map((a) => `<option value="${a.id}" data-type="${a.type}">${escapeHtml(a.name)} (${accountTypeLabel(a.type)})</option>`).join('');
  const defaultAccountId = await getSetting('defaultAccountId');
  const categoryOptions = categories.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('')
    + '<option value="__new__">+ New category…</option>';

  openModal({
    title: 'Add Expense',
    bodyHtml: `
      <form id="form-expense">
        <div class="field">
          <label for="exp-account">Paid from</label>
          <select class="select" id="exp-account">${accountOptions}</select>
          <span class="field-hint hidden" id="exp-card-hint">This will increase this card's used amount.</span>
        </div>
        <div class="field">
          <label for="exp-amount">Amount</label>
          <input class="input" id="exp-amount" type="number" min="0.01" step="0.01" required />
        </div>
        <div class="field">
          <label for="exp-category">Category *</label>
          <select class="select" id="exp-category" required>${categoryOptions}</select>
        </div>
        <div class="field hidden" id="exp-new-category-field">
          <label for="exp-new-category">New category name</label>
          <input class="input" id="exp-new-category" type="text" placeholder="e.g. Pet care" />
        </div>
        <div class="field">
          <label for="exp-desc">Description (optional)</label>
          <input class="input" id="exp-desc" type="text" placeholder="e.g. Grocery run" />
        </div>
        <div class="field">
          <label for="exp-date">Date</label>
          <input class="input" id="exp-date" type="date" value="${new Date().toISOString().slice(0, 10)}" />
        </div>
        <div class="field">
          <label for="exp-attachment">Attachment (optional, under 1.5 MB)</label>
          <input class="input" id="exp-attachment" type="file" accept="image/*,application/pdf" />
        </div>
      </form>
    `,
    onMount: (root) => {
      const accountSelect = qs('#exp-account', root);
      if (defaultAccountId) accountSelect.value = defaultAccountId;
      const syncCardHint = () => {
        const type = accountSelect.selectedOptions[0]?.dataset.type;
        qs('#exp-card-hint', root).classList.toggle('hidden', type !== 'credit_card');
      };
      accountSelect.addEventListener('change', syncCardHint);
      syncCardHint();

      qs('#exp-category', root).addEventListener('change', (e) => {
        qs('#exp-new-category-field', root).classList.toggle('hidden', e.target.value !== '__new__');
      });
    },
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Add Expense',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const accountId = qs('#exp-account', root).value;
          const amount = Number(qs('#exp-amount', root).value);
          let category = qs('#exp-category', root).value;
          const description = qs('#exp-desc', root).value;
          const date = qs('#exp-date', root).value ? new Date(qs('#exp-date', root).value).toISOString() : undefined;
          const file = qs('#exp-attachment', root).files[0];

          try {
            if (category === '__new__') {
              const newName = qs('#exp-new-category', root).value;
              const created = await createCategory({ name: newName, kind: 'expense' });
              category = created.name;
            }
            const attachment = file ? await readFileAsAttachment(file) : undefined;
            await createExpense({ accountId, amount, category, description, date, attachment });
            close();
            toast.success('Expense added.');
            page = 1;
            refresh();
          } catch (err) {
            if (err instanceof CreditLimitExceededError) {
              toast.error(err.message);
            } else if (err instanceof ValidationError || err.message?.includes('Attachment')) {
              toast.error(err.message);
            } else {
              toast.error('Something went wrong adding the expense.');
            }
          }
        },
      },
    ],
  });
}
