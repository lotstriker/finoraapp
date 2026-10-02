// ==========================================================================
// Finora — pages/income-page.js
// ==========================================================================

import { getAccounts, accountTypeLabel } from '../modules/accounts.js';
import { getCategories, createCategory } from '../modules/categories.js';
import { createIncome, getIncomeEntries } from '../modules/income.js';
import { getSetting } from '../modules/preferences.js';
import { ValidationError } from '../core/ledger.js';
import { formatCurrency } from '../utils/currency.js';
import { formatDate, escapeHtml, qs, qsa, renderPagination as renderPaginationUI } from '../utils/dom.js';
import { icons } from '../utils/icons.js';
import { openModal } from '../core/modal.js';
import { toast } from '../core/toast.js';
import { readFileAsAttachment } from '../utils/attachment.js';

let container = null;
let searchTerm = '';
let page = 1;
const PAGE_SIZE = 10;

export async function renderIncomePage(root) {
  container = root;
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <h1>Income</h1>
          <p class="page-subtitle">Record and review income transactions.</p>
        </div>
        <button class="btn btn-primary" id="btn-add-income">${icons.plus} Add Income</button>
      </div>
      <div class="field" style="max-width:320px;">
        <input class="input" id="income-search" type="text" placeholder="Search description or category" />
      </div>
      <div class="list mt-3" id="income-list"></div>
      <div id="income-pagination" style="display:flex; justify-content:center; gap: var(--sp-2); margin-top: var(--sp-4);"></div>
    </div>
  `;

  qs('#btn-add-income', root).addEventListener('click', openAddIncomeModal);
  qs('#income-search', root).addEventListener('input', (e) => {
    searchTerm = e.target.value.toLowerCase();
    page = 1;
    refresh();
  });

  await refresh();
}

async function refresh() {
  const entries = await getIncomeEntries();
  const filtered = searchTerm
    ? entries.filter((e) => (e.description || '').toLowerCase().includes(searchTerm) || (e.category || '').toLowerCase().includes(searchTerm))
    : entries;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  page = Math.min(page, totalPages);
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const listEl = qs('#income-list', container);
  if (pageItems.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><h3>No income recorded</h3><p>Add your first income entry to see it here.</p></div>`;
  } else {
    listEl.innerHTML = pageItems.map((t) => `
      <div class="list-row">
        <div class="row-icon">${icons.income}</div>
        <div class="row-main">
          <div class="row-title">${escapeHtml(t.description || t.category)}</div>
          <div class="row-sub">${escapeHtml(t.category || '')}${t.source ? ` · ${escapeHtml(t.source)}` : ''} · ${formatDate(t.date)}</div>
        </div>
        <span class="amount num amount--in">+${formatCurrency(t.amount)}</span>
      </div>
    `).join('');
  }

  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  renderPaginationUI(qs('#income-pagination', container), page, totalPages, (newPage) => { page = newPage; refresh(); });
}

async function openAddIncomeModal() {
  const [accounts, categories] = await Promise.all([getAccounts(), getCategories('income')]);

  if (accounts.length === 0) {
    toast.warning('Add an account first before recording income.');
    return;
  }

  const accountOptions = accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)} (${accountTypeLabel(a.type)})</option>`).join('');
  const defaultAccountId = await getSetting('defaultAccountId');
  const categoryOptions = categories.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('')
    + '<option value="__new__">+ New category…</option>';

  openModal({
    title: 'Add Income',
    bodyHtml: `
      <form id="form-income">
        <div class="field">
          <label for="inc-account">To account</label>
          <select class="select" id="inc-account">${accountOptions}</select>
        </div>
        <div class="field">
          <label for="inc-amount">Amount</label>
          <input class="input" id="inc-amount" type="number" min="0.01" step="0.01" required />
        </div>
        <div class="field">
          <label for="inc-category">Category *</label>
          <select class="select" id="inc-category" required>${categoryOptions}</select>
        </div>
        <div class="field hidden" id="inc-new-category-field">
          <label for="inc-new-category">New category name</label>
          <input class="input" id="inc-new-category" type="text" placeholder="e.g. Consulting" />
        </div>
        <div class="field">
          <label for="inc-source">Source (optional)</label>
          <input class="input" id="inc-source" type="text" placeholder="e.g. ABC Company, Upwork" />
        </div>
        <div class="field">
          <label for="inc-desc">Description (optional)</label>
          <input class="input" id="inc-desc" type="text" placeholder="e.g. August salary" />
        </div>
        <div class="field">
          <label for="inc-date">Date</label>
          <input class="input" id="inc-date" type="date" value="${new Date().toISOString().slice(0, 10)}" />
        </div>
        <div class="field">
          <label for="inc-attachment">Attachment (optional, under 1.5 MB)</label>
          <input class="input" id="inc-attachment" type="file" accept="image/*,application/pdf" />
        </div>
      </form>
    `,
    onMount: (root) => {
      if (defaultAccountId) qs('#inc-account', root).value = defaultAccountId;
      qs('#inc-category', root).addEventListener('change', (e) => {
        qs('#inc-new-category-field', root).classList.toggle('hidden', e.target.value !== '__new__');
      });
    },
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Add Income',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const accountId = qs('#inc-account', root).value;
          const amount = Number(qs('#inc-amount', root).value);
          let category = qs('#inc-category', root).value;
          const source = qs('#inc-source', root).value;
          const description = qs('#inc-desc', root).value;
          const date = qs('#inc-date', root).value ? new Date(qs('#inc-date', root).value).toISOString() : undefined;
          const file = qs('#inc-attachment', root).files[0];

          try {
            if (category === '__new__') {
              const newName = qs('#inc-new-category', root).value;
              const created = await createCategory({ name: newName, kind: 'income' });
              category = created.name;
            }
            const attachment = file ? await readFileAsAttachment(file) : undefined;
            await createIncome({ accountId, amount, category, source, description, date, attachment });
            close();
            toast.success('Income added.');
            page = 1;
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError || err.message?.includes('Attachment') ? err.message : 'Something went wrong adding income.');
          }
        },
      },
    ],
  });
}
