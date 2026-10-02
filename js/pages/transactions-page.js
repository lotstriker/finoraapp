// ==========================================================================
// Finora — pages/transactions-page.js
// The one place that shows every ledger entry across every account, with
// the two locked correction mechanisms exposed: reversal (new linked
// transaction) and limited note editing (description/tags only).
// ==========================================================================

import { getAll, getById as dbGetById } from '../core/db.js';
import { reverseTransaction, updateTransactionNotes, ValidationError } from '../core/ledger.js';
import { getAccounts } from '../modules/accounts.js';
import { getPeople, getPersonById } from '../modules/people.js';
import { reverseEmiPayment, getLoanById, getInstallments } from '../modules/loans.js';
import { reverseContribution, getGoalById } from '../modules/savings.js';
import { reverseCycle, getCommitteeById } from '../modules/committees.js';
import { reverseRecurringPayment } from '../modules/recurring.js';
import { recordRefund, getRefundsFor } from '../modules/expenses.js';
import { getSavedFilters, saveFilter, deleteSavedFilter } from '../modules/preferences.js';
import { formatCurrency, formatSignedCurrency } from '../utils/currency.js';
import { formatDate, escapeHtml, qs, bindRowActivation, renderPagination as renderPaginationUI } from '../utils/dom.js';
import { icons } from '../utils/icons.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { toast } from '../core/toast.js';

let container = null;
let searchTerm = '';
let typeFilter = 'all';
let page = 1;
const PAGE_SIZE = 15;

const TYPE_FILTERS = [
  { value: 'all', label: 'All types', match: () => true },
  { value: 'income', label: 'Income', match: (t) => t.type === 'income' },
  { value: 'expense', label: 'Expense', match: (t) => t.type === 'expense' },
  { value: 'transfer', label: 'Transfer', match: (t) => t.type === 'transfer' },
  { value: 'external_funding', label: 'External Funding', match: (t) => t.type === 'external_funding' },
  { value: 'people', label: 'People', match: (t) => t.module === 'people' },
  { value: 'loans', label: 'Loans & EMI', match: (t) => t.module === 'loans' },
  { value: 'bidsave', label: 'Bid & Save', match: (t) => t.module === 'bidsave' },
  { value: 'savings', label: 'Savings', match: (t) => t.module === 'savings' },
  { value: 'recurring', label: 'Recurring', match: (t) => t.module === 'recurring' },
];

export async function renderTransactionsPage(root, params) {
  container = root;
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <h1>Transactions</h1>
          <p class="page-subtitle">The complete financial ledger — every account, module, and money movement.</p>
        </div>
      </div>
      <div style="display:flex; gap: var(--sp-3); flex-wrap:wrap; margin-bottom: var(--sp-2);">
        <div class="field" style="flex:1; min-width:200px; margin-bottom:0;">
          <input class="input" id="txn-search" type="text" placeholder="Search description, category, account, person, amount, tags…" />
        </div>
        <div class="field" style="min-width:170px; margin-bottom:0;">
          <select class="select" id="txn-type-filter">
            ${TYPE_FILTERS.map((f) => `<option value="${f.value}">${f.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="flex-row-wrap mb-3">
        <select class="select" id="txn-saved-filters" style="max-width:220px;">
          <option value="">Saved filters…</option>
        </select>
        <button class="btn btn-secondary btn-sm" id="btn-save-filter">Save current filter</button>
        <button class="btn btn-ghost btn-sm hidden" id="btn-delete-filter">Delete</button>
      </div>
      <div class="list" id="txn-list"></div>
      <div id="txn-pagination" style="display:flex; justify-content:center; gap: var(--sp-2); margin-top: var(--sp-4);"></div>
    </div>
  `;

  qs('#txn-search', root).addEventListener('input', (e) => { searchTerm = e.target.value.toLowerCase(); page = 1; refresh(); });
  qs('#txn-type-filter', root).addEventListener('change', (e) => { typeFilter = e.target.value; page = 1; refresh(); });

  qs('#txn-saved-filters', root).addEventListener('change', (e) => {
    const id = e.target.value;
    qs('#btn-delete-filter', root).classList.toggle('hidden', !id);
    if (!id) return;
    const opt = e.target.selectedOptions[0];
    searchTerm = opt.dataset.search || '';
    typeFilter = opt.dataset.type || 'all';
    qs('#txn-search', root).value = searchTerm;
    qs('#txn-type-filter', root).value = typeFilter;
    page = 1;
    refresh();
  });

  qs('#btn-delete-filter', root).addEventListener('click', async () => {
    const id = qs('#txn-saved-filters', root).value;
    if (!id) return;
    await deleteSavedFilter(id);
    toast.success('Filter deleted.');
    qs('#btn-delete-filter', root).classList.add('hidden');
    await renderSavedFiltersDropdown(root);
  });

  qs('#btn-save-filter', root).addEventListener('click', () => openSaveFilterModal(root));

  await renderSavedFiltersDropdown(root);
  await refresh();

  const openId = params?.get?.('open');
  if (openId) {
    const [accounts] = await Promise.all([getAccounts({ includeArchived: true })]);
    const accountsById = Object.fromEntries(accounts.map((a) => [a.id, a]));
    const all = await getAll('ledger');
    const reversedIds = new Set(all.filter((t) => t.parentTransactionId).map((t) => t.parentTransactionId));
    openDetail(openId, accountsById, reversedIds);
  }
}

async function renderSavedFiltersDropdown(root) {
  const filters = await getSavedFilters();
  const select = qs('#txn-saved-filters', root);
  select.innerHTML = `<option value="">Saved filters…</option>` + filters.map((f) =>
    `<option value="${f.id}" data-search="${escapeHtml(f.searchTerm || '')}" data-type="${f.typeFilter}">${escapeHtml(f.name)}</option>`
  ).join('');
}

function openSaveFilterModal(root) {
  const typeLabel = TYPE_FILTERS.find((t) => t.value === typeFilter)?.label || 'All types';
  openModal({
    title: 'Save Current Filter',
    bodyHtml: `
      <p class="text-sm text-muted mb-3">Search: "${escapeHtml(searchTerm || '(none)')}" · Type: ${escapeHtml(typeLabel)}</p>
      <div class="field mb-0">
        <label for="sf-name">Name this filter</label>
        <input class="input" id="sf-name" type="text" placeholder="e.g. Credit card expenses" autofocus />
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Save',
        variant: 'btn-primary',
        onClick: async (close, modalRoot) => {
          const name = qs('#sf-name', modalRoot).value.trim();
          if (!name) { toast.error('Give this filter a name.'); return; }
          await saveFilter({ name, searchTerm, typeFilter });
          close();
          toast.success('Filter saved.');
          await renderSavedFiltersDropdown(root);
        },
      },
    ],
  });
}

async function refresh() {
  const [all, accounts, people] = await Promise.all([getAll('ledger'), getAccounts({ includeArchived: true }), getPeople({ includeArchived: true })]);
  const accountsById = Object.fromEntries(accounts.map((a) => [a.id, a]));
  const peopleById = Object.fromEntries(people.map((p) => [p.id, p]));
  const reversedIds = new Set(all.filter((t) => t.parentTransactionId).map((t) => t.parentTransactionId));

  let filtered = all;
  if (typeFilter !== 'all') {
    const filterDef = TYPE_FILTERS.find((f) => f.value === typeFilter);
    if (filterDef) filtered = filtered.filter(filterDef.match);
  }
  if (searchTerm) {
    const normalizedAmountSearch = searchTerm.replace(/[₹$€£,\s]/g, '');
    filtered = filtered.filter((t) =>
      (t.description || '').toLowerCase().includes(searchTerm) ||
      (t.category || '').toLowerCase().includes(searchTerm) ||
      (t.source || '').toLowerCase().includes(searchTerm) ||
      (t.type || '').toLowerCase().includes(searchTerm) ||
      (normalizedAmountSearch && String(t.amount).includes(normalizedAmountSearch)) ||
      (t.id || '').toLowerCase().includes(searchTerm) ||
      (accountsById[t.accountId]?.name || '').toLowerCase().includes(searchTerm) ||
      (t.personId && (peopleById[t.personId]?.name || '').toLowerCase().includes(searchTerm)) ||
      (t.tags || []).some((tag) => tag.toLowerCase().includes(searchTerm))
    );
  }
  filtered = filtered.sort((a, b) => new Date(b.date) - new Date(a.date));

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  page = Math.min(page, totalPages);
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const listEl = qs('#txn-list', container);
  if (pageItems.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><h3>No transactions found</h3><p>Try a different search or filter.</p></div>`;
  } else {
    listEl.innerHTML = pageItems.map((t) => row(t, accountsById, reversedIds)).join('');
    listEl.querySelectorAll('.list-row').forEach((el) => {
      bindRowActivation(el, () => openDetail(el.dataset.id, accountsById, reversedIds));
    });
  }

  renderPagination(totalPages);
}

function row(t, accountsById, reversedIds) {
  const acc = accountsById[t.accountId];
  const toAcc = t.toAccountId ? accountsById[t.toAccountId] : null;
  const sub = toAcc ? `${acc?.name || '—'} → ${toAcc.name}` : (acc?.name || '—');
  const dirClass = t.direction === 'in' ? 'in' : t.direction === 'out' ? 'out' : 'transfer';

  const badges = [];
  if (t.status === 'insufficient_balance') badges.push('<span class="badge badge-warning">Insufficient balance</span>');
  if (reversedIds.has(t.id)) badges.push('<span class="badge badge-neutral">Reversed</span>');
  if (t.parentTransactionId) badges.push('<span class="badge badge-neutral">Reversal</span>');

  return `
    <div class="list-row is-clickable" data-id="${t.id}">
      <div class="row-icon">${icons[t.type] || icons.other}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(t.description || t.type)}</div>
        <div class="row-sub">${escapeHtml(sub)} · ${formatDate(t.date)} ${badges.join(' ')}</div>
      </div>
      <div class="row-trail">
        <span class="amount num amount--${dirClass}">${formatSignedCurrency(t.amount, t.direction)}</span>
        <span class="chevron">${icons.chevron}</span>
      </div>
    </div>
  `;
}

function renderPagination(totalPages) {
  renderPaginationUI(qs('#txn-pagination', container), page, totalPages, (newPage) => { page = newPage; refresh(); });
}

/* ---------------------------------------------------------------------- */
/* Detail modal — Edit Note + Reverse                                     */
/* ---------------------------------------------------------------------- */

async function getModuleDetailHtml(t) {
  if (t.type === 'expense') {
    const refunds = await getRefundsFor(t.id);
    if (refunds.length === 0) return '';
    const totalRefunded = refunds.reduce((s, r) => s + r.amount, 0);
    return `
      <div><span class="text-muted">Refunded</span><br/>${formatCurrency(totalRefunded)} of ${formatCurrency(t.amount)} · Net ${formatCurrency(t.amount - totalRefunded)}</div>
    `;
  }
  if (t.type === 'refund') {
    const original = await dbGetById('ledger', t.moduleRef);
    if (!original) return '';
    return `<div><span class="text-muted">Refund for</span><br/>${escapeHtml(original.description || 'Expense')} · ${formatDate(original.date)}</div>`;
  }
  if (t.type === 'committee_payment' || t.type === 'committee_payout') {
    const cycle = await dbGetById('committee_cycles', t.moduleRef);
    if (!cycle) return '';
    const committee = await getCommitteeById(cycle.committeeId);
    return `
      <div><span class="text-muted">Committee</span><br/>${escapeHtml(committee?.name || '—')}</div>
      <div><span class="text-muted">Cycle</span><br/>#${cycle.cycleNo} · ${formatDate(cycle.month)}</div>
      <div><span class="text-muted">Winning Bid</span><br/>${formatCurrency(cycle.winningBid)}</div>
      <div><span class="text-muted">Your Profit</span><br/>${formatCurrency(cycle.userSaving)}</div>
    `;
  }
  if (t.type === 'loan_emi' || t.type === 'loan_disbursement') {
    const loan = await getLoanById(t.moduleRef);
    if (!loan) return '';
    let installmentInfo = '';
    if (t.type === 'loan_emi') {
      const installments = await getInstallments(t.moduleRef);
      const inst = installments.find((i) => i.paidTransactionId === t.id);
      if (inst) {
        installmentInfo = `<div><span class="text-muted">Installment</span><br/>#${inst.installmentNumber} · Due ${formatDate(inst.dueDate)}${inst.paidDate ? ` · Paid ${formatDate(inst.paidDate)}` : ''}</div>`;
      }
    }
    return `<div><span class="text-muted">Loan</span><br/>${escapeHtml(loan.name)}</div>${installmentInfo}`;
  }
  if (t.type === 'savings_contribution' || t.type === 'savings_withdrawal') {
    const goal = await getGoalById(t.moduleRef);
    if (!goal) return '';
    return `<div><span class="text-muted">Savings Goal</span><br/>${escapeHtml(goal.name)} · ${formatCurrency(goal.currentAmount)} of ${formatCurrency(goal.targetAmount)}</div>`;
  }
  if (t.personId) {
    const person = await getPersonById(t.personId);
    if (!person) return '';
    return `
      <div><span class="text-muted">Person</span><br/>${escapeHtml(person.name)}</div>
      ${t.dueDate ? `<div><span class="text-muted">Due Date</span><br/>${formatDate(t.dueDate)}</div>` : ''}
    `;
  }
  return '';
}

async function openDetail(id, accountsById, reversedIds) {
  const all = await getAll('ledger');
  const t = all.find((r) => r.id === id);
  if (!t) return;

  const acc = accountsById[t.accountId];
  const toAcc = t.toAccountId ? accountsById[t.toAccountId] : null;
  const isReversal = !!t.parentTransactionId;
  const alreadyReversed = reversedIds.has(t.id);
  const moduleDetailHtml = await getModuleDetailHtml(t);

  const detailHtml = `
    <div class="text-sm flex-col">
      <div><span class="text-muted">Amount</span><br/><span class="amount num">${formatCurrency(t.amount)}</span></div>
      <div><span class="text-muted">Account</span><br/>${escapeHtml(acc?.name || '—')}${toAcc ? ` → ${escapeHtml(toAcc.name)}` : ''}</div>
      ${t.category ? `<div><span class="text-muted">Category</span><br/>${escapeHtml(t.category)}</div>` : ''}
      <div><span class="text-muted">Date</span><br/>${formatDate(t.date)}</div>
      <div><span class="text-muted">Description</span><br/><span id="detail-desc-view">${escapeHtml(t.description || '—')}</span></div>
      ${t.source ? `<div><span class="text-muted">Source</span><br/>${escapeHtml(t.source)}</div>` : ''}
      ${moduleDetailHtml ? `<div style="border-top:1px solid var(--color-border); padding-top: var(--sp-2); display:flex; flex-direction:column; gap: var(--sp-2);">${moduleDetailHtml}</div>` : ''}
      <div><span class="text-muted">Reference</span><br/><span class="text-xs text-faint">${t.id}</span></div>
      ${t.attachment ? `
        <div>
          <span class="text-muted">Attachment</span><br/>
          ${t.attachment.type?.startsWith('image/')
            ? `<a href="${t.attachment.dataUrl}" target="_blank" rel="noopener"><img src="${t.attachment.dataUrl}" alt="${escapeHtml(t.attachment.name)}" style="max-width:180px; border-radius: var(--radius-sm); margin-top:4px; display:block;" /></a>`
            : `<a href="${t.attachment.dataUrl}" download="${escapeHtml(t.attachment.name)}" class="btn btn-secondary btn-sm" style="margin-top:4px;">${escapeHtml(t.attachment.name)}</a>`}
        </div>` : ''}
      ${isReversal ? `<div class="badge badge-neutral align-start">Reversal of ${t.parentTransactionId}</div>` : ''}
      ${alreadyReversed ? `<div class="badge badge-neutral align-start">Already reversed</div>` : ''}
      ${t.status === 'insufficient_balance' ? `<div class="badge badge-warning align-start">Recorded with insufficient balance</div>` : ''}
    </div>
  `;

  const actions = [
    { label: 'Edit Note', variant: 'btn-secondary', onClick: (close) => { close(); openEditNoteModal(t); } },
  ];
  if (t.type === 'expense' && !isReversal) {
    const refunds = await getRefundsFor(t.id);
    const remaining = t.amount - refunds.reduce((s, r) => s + r.amount, 0);
    if (remaining > 0) {
      actions.push({ label: 'Refund', variant: 'btn-secondary', onClick: (close) => { close(); openRefundModal(t, remaining); } });
    }
  }
  if (!isReversal && !alreadyReversed) {
    actions.push({ label: 'Reverse', variant: 'btn-danger', onClick: (close) => { close(); openReverseModal(t); } });
  }
  actions.push({ label: 'Close', variant: 'btn-ghost', onClick: (close) => close() });

  openModal({ title: t.description || t.type, size: 'md', bodyHtml: detailHtml, actions });
}

function openRefundModal(expense, remaining) {
  getAccounts().then((accounts) => {
    const options = accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
    openModal({
      title: `Refund · ${expense.description || 'Expense'}`,
      bodyHtml: `
        <p class="text-sm mb-3">Refundable up to ${formatCurrency(remaining)}.</p>
        <div class="field">
          <label for="rf-account">Refund into</label>
          <select class="select" id="rf-account">${options}</select>
        </div>
        <div class="field">
          <label for="rf-amount">Amount</label>
          <input class="input" id="rf-amount" type="number" min="0.01" max="${remaining}" step="0.01" value="${remaining}" />
        </div>
        <div class="field">
          <label for="rf-desc">Description (optional)</label>
          <input class="input" id="rf-desc" type="text" />
        </div>
      `,
      actions: [
        { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
        {
          label: 'Record Refund',
          variant: 'btn-primary',
          onClick: async (close, root) => {
            const accountId = qs('#rf-account', root).value;
            const amount = Number(qs('#rf-amount', root).value);
            const description = qs('#rf-desc', root).value;
            try {
              await recordRefund(expense.id, { accountId, amount, description });
              close();
              toast.success('Refund recorded.');
              refresh();
            } catch (err) {
              toast.error(err instanceof ValidationError ? err.message : 'Something went wrong recording the refund.');
            }
          },
        },
      ],
    });
  });
}

function openEditNoteModal(t) {
  openModal({
    title: 'Edit Note',
    bodyHtml: `
      <div class="field">
        <label for="edit-desc">Description</label>
        <input class="input" id="edit-desc" type="text" value="${escapeHtml(t.description || '')}" />
      </div>
      <div class="field">
        <label for="edit-tags">Tags (comma separated, optional)</label>
        <input class="input" id="edit-tags" type="text" value="${escapeHtml((t.tags || []).join(', '))}" />
      </div>
      <p class="field-hint">Amount, date, account and type can't be changed here — use Reverse for those.</p>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Save',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const description = qs('#edit-desc', root).value;
          const tags = qs('#edit-tags', root).value.split(',').map((s) => s.trim()).filter(Boolean);
          try {
            await updateTransactionNotes(t.id, { description, tags });
            close();
            toast.success('Note updated.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Could not update the note.');
          }
        },
      },
    ],
  });
}

function openReverseModal(t) {
  openModal({
    title: 'Reverse Transaction',
    bodyHtml: `
      <p class="text-sm mb-3">
        This posts a new, linked transaction that undoes ${formatCurrency(t.amount)} — the original stays in your history untouched.
        ${['loan_emi', 'savings_contribution', 'savings_withdrawal', 'committee_payment', 'committee_payout'].includes(t.type) || t.module === 'recurring'
          ? '<br/><span class="text-xs text-faint">Linked records (installment, savings goal, committee cycle, or recurring due date) are kept in sync automatically.</span>' : ''}
      </p>
      <div class="field">
        <label for="reverse-reason">Reason (optional)</label>
        <input class="input" id="reverse-reason" type="text" placeholder="e.g. Entered by mistake" />
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Reverse',
        variant: 'btn-danger',
        onClick: async (close, root) => {
          const reason = qs('#reverse-reason', root).value;
          try {
            if (t.type === 'loan_emi') {
              await reverseEmiPayment(t.id, reason);
            } else if (t.type === 'savings_contribution' || t.type === 'savings_withdrawal') {
              await reverseContribution(t.id, reason);
            } else if (t.type === 'committee_payment' || t.type === 'committee_payout') {
              await reverseCycle(t.moduleRef, reason);
            } else if (t.module === 'recurring') {
              await reverseRecurringPayment(t.id, reason);
            } else {
              await reverseTransaction(t.id, reason);
            }
            close();
            toast.success('Transaction reversed.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Could not reverse this transaction.');
          }
        },
      },
    ],
  });
}
