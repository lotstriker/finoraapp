// ==========================================================================
// Finora — pages/people-page.js
// ==========================================================================

import {
  getPeople, getPersonById, createPerson, archivePerson, unarchivePerson,
  lendToPerson, recordRepaymentReceived, borrowFromPerson, repayPerson,
  getLedgerForPerson, DuplicateNameError, getOutstandingLendings,
} from '../modules/people.js';
import { getAccounts } from '../modules/accounts.js';
import { ValidationError } from '../core/ledger.js';
import { formatCurrency, formatSignedCurrency } from '../utils/currency.js';
import { formatDate, escapeHtml, qs, bindRowActivation } from '../utils/dom.js';
import { icons } from '../utils/icons.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { toast } from '../core/toast.js';

let container = null;

export async function renderPeoplePage(root, params) {
  container = root;
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>People</h1>
        <button class="btn btn-primary" id="btn-add-person">${icons.plus} Add Person</button>
      </div>
      <div class="list" id="people-list"></div>
    </div>
  `;
  qs('#btn-add-person', root).addEventListener('click', openAddPersonModal);
  await refresh();

  const openId = params?.get?.('open');
  if (openId) openPersonDetail(openId);
}

async function refresh() {
  const people = await getPeople({ includeArchived: true });
  const listEl = qs('#people-list', container);

  if (people.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <h3>No people yet</h3>
        <p>Track money you lend to or borrow from friends and family.</p>
        <button class="btn btn-primary" id="btn-add-person-empty">${icons.plus} Add Person</button>
      </div>`;
    qs('#btn-add-person-empty', listEl).addEventListener('click', openAddPersonModal);
    return;
  }

  listEl.innerHTML = people.map((p) => {
    const owesYou = p.balance > 0;
    const label = p.balance === 0 ? 'Settled' : (owesYou ? 'Owes you' : 'You owe');
    return `
      <div class="list-row is-clickable" data-id="${p.id}">
        <div class="row-icon">${icons.people}</div>
        <div class="row-main">
          <div class="row-title">${escapeHtml(p.name)} ${p.archived ? '<span class="badge badge-neutral">Archived</span>' : ''}</div>
          <div class="row-sub">${label}</div>
        </div>
        <span class="amount num ${p.balance > 0 ? 'amount--in' : p.balance < 0 ? 'amount--out' : ''}">${formatCurrency(Math.abs(p.balance))}</span>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.list-row').forEach((row) => {
    bindRowActivation(row, () => openPersonDetail(row.dataset.id));
  });
}

function openAddPersonModal() {
  openModal({
    title: 'Add Person',
    bodyHtml: `
      <div class="field">
        <label for="p-name">Name</label>
        <input class="input" id="p-name" type="text" placeholder="e.g. Rahul Sharma" required />
      </div>
      <div class="field">
        <label for="p-phone">Phone (optional)</label>
        <input class="input" id="p-phone" type="text" placeholder="+91 90000 00000" />
      </div>
      <div class="field">
        <label for="p-email">Email (optional)</label>
        <input class="input" id="p-email" type="email" placeholder="name@example.com" />
      </div>
      <div class="field">
        <label for="p-notes">Notes (optional)</label>
        <input class="input" id="p-notes" type="text" placeholder="e.g. Colleague" />
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Add Person',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const name = qs('#p-name', root).value;
          const phone = qs('#p-phone', root).value;
          const email = qs('#p-email', root).value;
          const notes = qs('#p-notes', root).value;
          try {
            await createPerson({ name, phone, email, notes });
            close();
            toast.success(`${name} added.`);
            refresh();
          } catch (err) {
            if (err instanceof DuplicateNameError) {
              close();
              const proceed = await confirmDialog({ title: 'Duplicate name', message: err.message, confirmLabel: 'Add Anyway' });
              if (proceed) {
                try {
                  await createPerson({ name, phone, email, notes, confirmDuplicate: true });
                  toast.success(`${name} added.`);
                  refresh();
                } catch (e2) { toast.error(e2.message); }
              }
            } else {
              toast.error(err instanceof ValidationError ? err.message : 'Something went wrong.');
            }
          }
        },
      },
    ],
  });
}

async function openPersonDetail(id) {
  const person = await getPersonById(id);
  if (!person) return;
  const history = await getLedgerForPerson(id);
  const [outstandingOut, outstandingIn] = await Promise.all([
    getOutstandingLendings(id, 'out'),
    getOutstandingLendings(id, 'in'),
  ]);
  const settlementById = Object.fromEntries([...outstandingOut, ...outstandingIn].map((l) => [l.id, l]));

  const owesYou = person.balance > 0;
  const balanceLabel = person.balance === 0 ? 'Settled up' : (owesYou ? 'Owes you' : 'You owe');
  const balanceClass = person.balance > 0 ? 'amount--in' : person.balance < 0 ? 'amount--out' : '';

  const statusBadge = (t) => {
    if (t.type !== 'person_lending') return '';
    const l = settlementById[t.id];
    if (!l) return '';
    if (l.settlementStatus === 'settled') return ' <span class="badge badge-success">Settled</span>';
    if (l.settlementStatus === 'partial') return ` <span class="badge badge-warning">Partial · ${formatCurrency(l.remaining)} left</span>`;
    if (l.settlementStatus === 'overdue') return ' <span class="badge badge-danger">Overdue</span>';
    if (l.settlementStatus === 'due_today') return ' <span class="badge badge-warning">Due Today</span>';
    if (t.dueDate) return ` <span class="badge badge-neutral">Due ${formatDate(t.dueDate)}</span>`;
    return '';
  };

  const historyHtml = history.length ? history.slice(0, 10).map((t) => `
    <div class="list-row">
      <div class="row-icon">${icons.people}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(t.description || t.type)}</div>
        <div class="row-sub">${escapeHtml(t.category || '')}${t.category ? ' · ' : ''}${formatDate(t.date)}${statusBadge(t)}</div>
      </div>
      <span class="amount num amount--${t.direction === 'out' ? 'out' : 'in'}">${formatSignedCurrency(t.amount, t.direction === 'out' ? 'out' : 'in')}</span>
    </div>
  `).join('') : `<div class="empty-state"><h3>No transactions yet</h3></div>`;

  openModal({
    title: person.name,
    size: 'md',
    bodyHtml: `
      <p class="text-sm text-muted mb-3">${person.phone || ''}${person.phone && person.email ? ' · ' : ''}${person.email || ''}</p>
      <div class="mb-4">
        <span class="stat-label">${balanceLabel}</span><br/>
        <span class="amount amount--lg num ${balanceClass}">${formatCurrency(Math.abs(person.balance))}</span>
      </div>
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2); margin-bottom: var(--sp-4);">
        <button class="btn btn-secondary btn-sm" id="act-lend">Lend Money</button>
        <button class="btn btn-secondary btn-sm" id="act-received">Received Repayment</button>
        <button class="btn btn-secondary btn-sm" id="act-borrow">Borrowed Money</button>
        <button class="btn btn-secondary btn-sm" id="act-repay">Repaid Them</button>
      </div>
      <div class="list">${historyHtml}</div>
    `,
    actions: [
      ...(person.archived
        ? [{ label: 'Unarchive', variant: 'btn-secondary', onClick: async (close) => { await unarchivePerson(id); close(); toast.success('Restored.'); refresh(); } }]
        : [{ label: 'Archive', variant: 'btn-secondary', onClick: async (close) => {
              const ok = await confirmDialog({ title: 'Archive person', message: `Hide "${person.name}" from your active list? History is kept.` });
              if (ok) { await archivePerson(id); close(); toast.success('Archived.'); refresh(); }
            } }]),
      { label: 'Close', variant: 'btn-ghost', onClick: (close) => close() },
    ],
    onMount: (root) => {
      qs('#act-lend', root).addEventListener('click', () => openMoneyModal(person, 'lend'));
      qs('#act-received', root).addEventListener('click', () => openMoneyModal(person, 'received'));
      qs('#act-borrow', root).addEventListener('click', () => openMoneyModal(person, 'borrow'));
      qs('#act-repay', root).addEventListener('click', () => openMoneyModal(person, 'repay'));
    },
  });
}

const ACTION_META = {
  lend: { title: 'Lend Money', fn: lendToPerson, hint: 'Money leaves your account and goes to them.' },
  received: { title: 'Received Repayment', fn: recordRepaymentReceived, hint: 'Money comes into your account from them.' },
  borrow: { title: 'Borrowed Money', fn: borrowFromPerson, hint: 'Money comes into your account from them.' },
  repay: { title: 'Repay Them', fn: repayPerson, hint: 'Money leaves your account and goes to them.' },
};

async function openMoneyModal(person, actionKey) {
  const meta = ACTION_META[actionKey];
  const isDebtCreating = actionKey === 'lend' || actionKey === 'borrow';
  const isRepayment = actionKey === 'received' || actionKey === 'repay';
  const accounts = await getAccounts();
  if (accounts.length === 0) {
    toast.warning('Add an account first.');
    return;
  }
  const accountOptions = accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');

  let outstanding = [];
  if (isRepayment) {
    const lendDirection = actionKey === 'received' ? 'out' : 'in';
    outstanding = (await getOutstandingLendings(person.id, lendDirection)).filter((l) => l.remaining > 0);
  }

  openModal({
    title: `${meta.title} · ${person.name}`,
    bodyHtml: `
      <p class="field-hint mb-3">${meta.hint}</p>
      <div class="field">
        <label for="mm-account">Account</label>
        <select class="select" id="mm-account">${accountOptions}</select>
      </div>
      <div class="field">
        <label for="mm-amount">Amount</label>
        <input class="input" id="mm-amount" type="number" min="0.01" step="0.01" required />
      </div>
      ${isRepayment && outstanding.length > 0 ? `
      <div class="field">
        <label for="mm-settles">Apply to which entry? (optional)</label>
        <select class="select" id="mm-settles">
          <option value="">General repayment (not tied to one entry)</option>
          ${outstanding.map((l) => `<option value="${l.id}">${escapeHtml(l.description || 'Entry')} — ${formatCurrency(l.remaining)} remaining (${formatDate(l.date)})</option>`).join('')}
        </select>
      </div>` : ''}
      <div class="field">
        <label for="mm-desc">Description (optional)</label>
        <input class="input" id="mm-desc" type="text" />
      </div>
      ${isDebtCreating ? `
      <div class="field-row">
        <div class="field">
          <label for="mm-purpose">Purpose (optional)</label>
          <input class="input" id="mm-purpose" type="text" placeholder="e.g. Travel" />
        </div>
        <div class="field">
          <label for="mm-due">Due date (optional)</label>
          <input class="input" id="mm-due" type="date" />
        </div>
      </div>
      <div class="field">
        <label for="mm-tags">Tags (comma separated, optional)</label>
        <input class="input" id="mm-tags" type="text" placeholder="e.g. urgent, family" />
      </div>` : ''}
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: meta.title,
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const accountId = qs('#mm-account', root).value;
          const amount = Number(qs('#mm-amount', root).value);
          const description = qs('#mm-desc', root).value;
          const purpose = isDebtCreating ? qs('#mm-purpose', root).value : undefined;
          const dueVal = isDebtCreating ? qs('#mm-due', root).value : '';
          const dueDate = dueVal ? new Date(dueVal).toISOString() : undefined;
          const tags = isDebtCreating ? qs('#mm-tags', root).value.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
          const settlesTransactionId = (isRepayment && outstanding.length > 0) ? (qs('#mm-settles', root).value || undefined) : undefined;
          try {
            await meta.fn(person.id, { accountId, amount, description, purpose, dueDate, tags, settlesTransactionId });
            close();
            toast.success('Recorded.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Something went wrong.');
          }
        },
      },
    ],
  });
}
