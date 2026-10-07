// ==========================================================================
// Finora — pages/accounts-page.js
// ==========================================================================

import {
  getAccounts, getAccountById, createAccount, addMoney, adjustBalance,
  archiveAccount, unarchiveAccount, deleteAccount,
  ACCOUNT_TYPES, accountTypeLabel, DuplicateNameError,
} from '../modules/accounts.js';
import { getLedgerForAccount } from '../core/ledger.js';
import { ValidationError, CreditLimitExceededError } from '../core/ledger.js';
import { getSetting } from '../modules/preferences.js';
import { getPeople } from '../modules/people.js';
import { openAddTransferModal } from './transfers-page.js';
import { createTransfer } from '../modules/transfers.js';
import { recordRepaymentReceived } from '../modules/people.js';
import { formatCurrency, formatSignedCurrency } from '../utils/currency.js';
import { formatDate, escapeHtml, qs, bindRowActivation, renderPagination, enhanceTabs } from '../utils/dom.js';
import { icons, accountTypeIcon } from '../utils/icons.js';
import { openModal, closeModal, confirmDialog } from '../core/modal.js';
import { toast } from '../core/toast.js';

let pageContainer = null;

export async function renderAccountsPage(container, params) {
  pageContainer = container;
  const accounts = await getAccounts({ includeArchived: true });

  container.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Accounts</h1>
        <button class="btn btn-primary" id="btn-add-account">${icons.plus} Add Account</button>
      </div>
      <div class="grid grid-cards mb-5" id="accounts-summary"></div>
      <div class="list" id="accounts-list"></div>
    </div>
  `;

  await renderSummary();
  renderList(accounts);
  qs('#btn-add-account', container).addEventListener('click', openCreateAccountModal);

  const openId = params?.get?.('open');
  if (openId) openAccountDetail(openId);
}

async function renderSummary() {
  const [accounts, people] = await Promise.all([getAccounts(), getPeople()]);
  const totalBalance = accounts.reduce((s, a) => s + (a.balance || 0), 0);
  const peopleNet = people.reduce((s, p) => s + (p.balance || 0), 0);

  qs('#accounts-summary', pageContainer).innerHTML = `
    <div class="card stat-card">
      <span class="stat-label">Total Balance</span>
      <span class="amount amount--lg num">${formatCurrency(totalBalance)}</span>
    </div>
    <div class="card stat-card">
      <span class="stat-label">Accounts</span>
      <span class="amount amount--lg num">${accounts.length}</span>
    </div>
    <a href="#/people" class="card stat-card">
      <span class="stat-label">People</span>
      <span class="amount amount--lg num">${people.length}</span>
      ${people.length ? `<span class="text-xs text-faint">${formatCurrency(Math.abs(peopleNet))} ${peopleNet >= 0 ? 'owed to you' : 'you owe'}</span>` : ''}
    </a>
  `;
}

function renderList(accounts) {
  const listEl = qs('#accounts-list', pageContainer);
  const active = accounts.filter((a) => !a.archived);
  const archived = accounts.filter((a) => a.archived);

  if (accounts.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <h3>No accounts yet</h3>
        <p>Add your first account — bank, wallet, cash, or card — to start tracking.</p>
        <button class="btn btn-primary" id="btn-add-account-empty">${icons.plus} Add Account</button>
      </div>`;
    qs('#btn-add-account-empty', listEl).addEventListener('click', openCreateAccountModal);
    return;
  }

  const rowHtml = (a) => `
    <div class="list-row is-clickable" data-id="${a.id}">
      <div class="row-icon">${accountTypeIcon[a.type] || icons.other}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(a.name)} ${a.archived ? '<span class="badge badge-neutral">Archived</span>' : ''}</div>
        <div class="row-sub">${accountTypeLabel(a.type)}${a.type === 'credit_card' ? ` · Limit ${formatCurrency(a.creditLimit)}` : ''}</div>
      </div>
      <div class="row-trail">
        <span class="amount num ${a.balance < 0 ? 'amount--out' : ''}">${formatCurrency(a.balance)}</span>
        <span class="chevron">${icons.chevron}</span>
      </div>
    </div>`;

  listEl.innerHTML = active.map(rowHtml).join('') + archived.map(rowHtml).join('');

  listEl.querySelectorAll('.list-row').forEach((row) => {
    bindRowActivation(row, () => openAccountDetail(row.dataset.id));
  });
}

async function refresh() {
  const accounts = await getAccounts({ includeArchived: true });
  renderList(accounts);
  await renderSummary();
}

/* ---------------------------------------------------------------------- */
/* Create Account                                                         */
/* ---------------------------------------------------------------------- */

function openCreateAccountModal() {
  const typeOptions = ACCOUNT_TYPES.map((t) => `<option value="${t.value}">${t.label}</option>`).join('');

  openModal({
    title: 'Add Account',
    bodyHtml: `
      <form id="form-add-account">
        <div class="field">
          <label for="acc-name">Account name</label>
          <input class="input" id="acc-name" type="text" placeholder="e.g. HDFC Savings" required />
        </div>
        <div class="field">
          <label for="acc-type">Type</label>
          <select class="select" id="acc-type">${typeOptions}</select>
        </div>
        <div class="field" id="field-initial">
          <label for="acc-initial">Initial balance (optional)</label>
          <input class="input" id="acc-initial" type="number" min="0" step="0.01" placeholder="0" />
          <span class="field-hint">This posts a real ledger entry — it's not a silent starting number.</span>
        </div>
        <div class="field hidden" id="field-limit">
          <label for="acc-limit">Credit limit</label>
          <input class="input" id="acc-limit" type="number" min="1" step="0.01" placeholder="50000" />
        </div>
      </form>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Add Account',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const name = qs('#acc-name', root).value;
          const type = qs('#acc-type', root).value;
          const initialBalance = qs('#acc-initial', root).value;
          const creditLimit = qs('#acc-limit', root).value;

          try {
            await createAccount({ name, type, initialBalance, creditLimit });
            close();
            toast.success(`${name} added.`);
            refresh();
          } catch (err) {
            if (err instanceof DuplicateNameError) {
              close();
              const proceed = await confirmDialog({
                title: 'Duplicate name',
                message: err.message,
                confirmLabel: 'Add Anyway',
              });
              if (proceed) {
                try {
                  await createAccount({ name, type, initialBalance, creditLimit, confirmDuplicate: true });
                  toast.success(`${name} added.`);
                  refresh();
                } catch (e2) {
                  toast.error(e2.message);
                }
              }
            } else if (err instanceof ValidationError) {
              toast.error(err.message);
            } else {
              toast.error('Something went wrong adding the account.');
            }
          }
        },
      },
    ],
    onMount: (root) => {
      const typeSelect = qs('#acc-type', root);
      const toggleFields = () => {
        const isCard = typeSelect.value === 'credit_card';
        qs('#field-initial', root).classList.toggle('hidden', isCard);
        qs('#field-limit', root).classList.toggle('hidden', !isCard);
      };
      typeSelect.addEventListener('change', toggleFields);
      toggleFields();
    },
  });
}

/* ---------------------------------------------------------------------- */
/* Account Detail                                                         */
/* ---------------------------------------------------------------------- */

let detailPage = 1;
const DETAIL_PAGE_SIZE = 15;

async function openAccountDetail(id) {
  const account = await getAccountById(id);
  if (!account) return;
  detailPage = 1;

  openModal({
    title: account.name,
    size: 'lg',
    bodyHtml: `
      <p class="text-sm text-muted mb-3">${accountTypeLabel(account.type)}${account.archived ? ' · Archived' : ''}</p>
      <div style="display:flex; gap: var(--sp-2); margin-bottom: var(--sp-4); border-bottom: 1px solid var(--color-border);">
        <button class="btn btn-ghost btn-sm tab-btn active" data-tab="overview" style="border-radius:0; border-bottom:2px solid var(--color-primary);">Overview</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="transactions" style="border-radius:0;">Transactions</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="reports" style="border-radius:0;">Reports</button>
      </div>
      <div id="tab-overview" class="tab-panel"></div>
      <div id="tab-transactions" class="tab-panel hidden"></div>
      <div id="tab-reports" class="tab-panel hidden"></div>
    `,
    actions: [
      ...(account.archived
        ? [{ label: 'Unarchive', variant: 'btn-secondary', onClick: async (close) => { await unarchiveAccount(id); close(); toast.success('Account restored.'); refresh(); } }]
        : [
            { label: 'Adjust Balance', variant: 'btn-secondary', onClick: (close) => { close(); openAdjustBalanceModal(account); } },
            { label: 'Transfer', variant: 'btn-secondary', onClick: (close) => { close(); openAddTransferModal(id, refresh); } },
            { label: 'Archive', variant: 'btn-secondary', onClick: async (close) => {
                const ok = await confirmDialog({ title: 'Archive account', message: `Hide "${account.name}" from your active accounts? Its history is kept.${Math.abs(account.balance || 0) > 0.005 ? ` It still holds ${formatCurrency(account.balance)}, which will no longer count in your Total Balance until you restore it.` : ''}` });
                if (ok) { await archiveAccount(id); close(); toast.success('Account archived.'); refresh(); }
              } },
            { label: 'Add Money', variant: 'btn-primary', onClick: (close) => { close(); openAddMoneyModal(account); } },
          ]),
      { label: 'Close', variant: 'btn-ghost', onClick: (close) => close() },
    ],
    onMount: async (root) => {
      root.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          root.querySelectorAll('.tab-btn').forEach((b) => { b.classList.remove('active'); b.style.borderBottom = 'none'; });
          btn.classList.add('active');
          btn.style.borderBottom = '2px solid var(--color-primary)';
          root.querySelectorAll('.tab-panel').forEach((p) => { p.classList.add('hidden'); });
          qs(`#tab-${btn.dataset.tab}`, root).classList.remove('hidden');
        });
      });

      enhanceTabs(root);
      await renderOverviewTab(root, account, id);
      await renderTransactionsTab(root, id);
      await renderReportsTab(root, id);
    },
  });
}

async function renderOverviewTab(root, account, id) {
  const history = await getLedgerForAccount(id);
  qs('#tab-overview', root).innerHTML = `
    <div class="grid grid-cards mb-4">
      <div class="card stat-card">
        <span class="stat-label">Balance</span>
        <span class="amount amount--lg num ${account.balance < 0 ? 'amount--out' : ''}">${formatCurrency(account.balance)}</span>
      </div>
      ${account.type === 'credit_card' ? `
        <div class="card stat-card">
          <span class="stat-label">Available Limit</span>
          <span class="amount amount--lg num amount--in">${formatCurrency(account.creditLimit - Math.max(0, account.usedAmount))}</span>
          <span class="text-xs text-faint">of ${formatCurrency(account.creditLimit)} · ${account.usedAmount < 0 ? `${formatCurrency(-account.usedAmount)} credit balance (overpaid)` : `used ${formatCurrency(account.usedAmount)}`}</span>
        </div>` : ''}
      <div class="card stat-card">
        <span class="stat-label">Money In</span>
        <span class="amount amount--lg num amount--in">${formatCurrency(history.filter((t) => (t.direction === 'in') || (t.direction === 'transfer' && t.toAccountId === id)).reduce((s, t) => s + t.amount, 0))}</span>
      </div>
      <div class="card stat-card">
        <span class="stat-label">Money Out</span>
        <span class="amount amount--lg num amount--out">${formatCurrency(history.filter((t) => (t.direction === 'out') || (t.direction === 'transfer' && t.accountId === id)).reduce((s, t) => s + t.amount, 0))}</span>
      </div>
    </div>
    <h3 style="font-size: var(--fs-sm); font-weight: 650; margin-bottom: var(--sp-2);">Recent Activity</h3>
    <div class="list">
      ${history.length ? history.slice(0, 5).map((t) => historyRow(t, id)).join('') : `
        <div class="empty-state"><h3>No transactions yet</h3><p>Use Add Money to record the first one.</p></div>
      `}
    </div>
  `;
}

async function renderTransactionsTab(root, id) {
  const history = await getLedgerForAccount(id);
  const renderPage = () => {
    const totalPages = Math.max(1, Math.ceil(history.length / DETAIL_PAGE_SIZE));
    detailPage = Math.min(detailPage, totalPages);
    const pageItems = history.slice((detailPage - 1) * DETAIL_PAGE_SIZE, detailPage * DETAIL_PAGE_SIZE);

    qs('#tab-transactions', root).innerHTML = `
      <div class="list">
        ${pageItems.length ? pageItems.map((t) => historyRow(t, id)).join('') : `<div class="empty-state"><h3>No transactions yet</h3></div>`}
      </div>
      <div id="detail-pagination" class="mt-3"></div>
    `;
    renderPagination(qs('#detail-pagination', root), detailPage, totalPages, (newPage) => { detailPage = newPage; renderPage(); });
  };
  renderPage();
}

async function renderReportsTab(root, id) {
  const history = await getLedgerForAccount(id);
  const now = new Date();
  const monthTxns = history.filter((t) => { const d = new Date(t.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
  const byCategory = {};
  monthTxns.filter((t) => t.type === 'expense').forEach((t) => {
    const key = t.category || 'Uncategorized';
    byCategory[key] = (byCategory[key] || 0) + t.amount;
  });
  const catRows = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);

  qs('#tab-reports', root).innerHTML = `
    <p class="text-sm text-muted mb-3">This month, this account only</p>
    <div class="list">
      ${catRows.length ? catRows.map(([cat, amt]) => `
        <div class="list-row">
          <div class="row-main"><div class="row-title">${escapeHtml(cat)}</div></div>
          <span class="amount num amount--out">${formatCurrency(amt)}</span>
        </div>
      `).join('') : `<div class="empty-state"><p>No expenses on this account this month.</p></div>`}
    </div>
  `;
}

function historyRow(txn, currentAccountId) {
  const isTransferOut = txn.direction === 'transfer' && txn.accountId === currentAccountId;
  const isTransferIn = txn.direction === 'transfer' && txn.toAccountId === currentAccountId;
  const effectiveDir = txn.direction === 'transfer' ? (isTransferOut ? 'out' : 'in') : txn.direction;
  const dirClass = effectiveDir === 'in' ? 'in' : 'out';

  return `
    <div class="list-row">
      <div class="row-icon">${icons[txn.type] || icons.other}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(txn.description || txn.type)}</div>
        <div class="row-sub">${formatDate(txn.date)}${txn.status === 'insufficient_balance' ? ' · <span class="badge badge-warning">Insufficient balance</span>' : ''}</div>
      </div>
      <span class="amount num amount--${dirClass}">${formatSignedCurrency(txn.amount, effectiveDir)}</span>
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* Add Money                                                               */
/* ---------------------------------------------------------------------- */

function openAdjustBalanceModal(account) {
  openModal({
    title: `Adjust Balance · ${account.name}`,
    bodyHtml: `
      <p class="text-sm mb-3">Current balance: <strong>${formatCurrency(account.balance)}</strong>. Enter the actual balance (e.g. from your bank statement) — Finora will record the exact difference, not silently overwrite it.</p>
      <div class="field">
        <label for="adj-actual">Actual balance</label>
        <input class="input" id="adj-actual" type="number" step="0.01" value="${account.balance}" required />
      </div>
      <div class="field">
        <label for="adj-reason">Reason (optional)</label>
        <input class="input" id="adj-reason" type="text" placeholder="e.g. Bank statement reconciliation" />
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Adjust Balance',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const actualBalance = Number(qs('#adj-actual', root).value);
          const reason = qs('#adj-reason', root).value;
          try {
            await adjustBalance(account.id, { actualBalance, reason });
            close();
            toast.success('Balance adjusted.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Something went wrong.');
          }
        },
      },
    ],
  });
}

async function openAddMoneyModal(account) {
  const isCreditCard = account.type === 'credit_card';
  const [otherAccounts, people] = await Promise.all([
    getAccounts().then((all) => all.filter((a) => a.id !== account.id)),
    getPeople(),
  ]);

  const sourceOptions = isCreditCard
    ? `<option value="transfer">Transfer from another account</option>`
    : `
      <option value="external_funding">External funding (cash in hand, gift, etc.)</option>
      <option value="income">Income</option>
      <option value="transfer">Transfer from another account</option>
      <option value="person_repayment">Person repayment</option>
    `;

  openModal({
    title: `Add Money · ${account.name}`,
    bodyHtml: `
      <form id="form-add-money">
        ${isCreditCard ? `<p class="field-hint mb-3">Credit cards are paid down by transfer, not recorded as income.</p>` : ''}
        <div class="field">
          <label for="am-source">Source</label>
          <select class="select" id="am-source">${sourceOptions}</select>
        </div>
        <div class="field hidden" id="am-transfer-field">
          <label for="am-from-account">From account</label>
          <select class="select" id="am-from-account">${otherAccounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}</select>
        </div>
        <div class="field hidden" id="am-person-field">
          <label for="am-person">Person</label>
          <select class="select" id="am-person">${people.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label for="am-amount">Amount</label>
          <input class="input" id="am-amount" type="number" min="0.01" step="0.01" placeholder="0" required />
        </div>
        <div class="field">
          <label for="am-desc">Description (optional)</label>
          <input class="input" id="am-desc" type="text" placeholder="e.g. Salary, refund, cash deposit" />
        </div>
      </form>
    `,
    onMount: (root) => {
      const sourceSelect = qs('#am-source', root);
      const sync = () => {
        const val = sourceSelect.value;
        qs('#am-transfer-field', root).classList.toggle('hidden', val !== 'transfer');
        qs('#am-person-field', root).classList.toggle('hidden', val !== 'person_repayment');
      };
      sourceSelect.addEventListener('change', sync);
      sync();
    },
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Add Money',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const source = qs('#am-source', root).value;
          const amount = Number(qs('#am-amount', root).value);
          const description = qs('#am-desc', root).value;
          try {
            if (source === 'transfer') {
              const fromAccountId = qs('#am-from-account', root).value;
              if (!fromAccountId) { toast.warning('Add another account first to transfer from.'); return; }
              await createTransfer({ fromAccountId, toAccountId: account.id, amount, description });
            } else if (source === 'person_repayment') {
              const personId = qs('#am-person', root).value;
              if (!personId) { toast.warning('Add a person first.'); return; }
              await recordRepaymentReceived(personId, { accountId: account.id, amount, description });
            } else {
              await addMoney(account.id, { amount, source, description });
            }
            close();
            toast.success(`${formatCurrency(amount)} added to ${account.name}.`);
            refresh();
          } catch (err) {
            if (err instanceof ValidationError || err instanceof CreditLimitExceededError) {
              toast.error(err.message);
            } else {
              toast.error('Something went wrong adding money.');
            }
          }
        },
      },
    ],
  });
}
