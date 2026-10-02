// ==========================================================================
// Finora — pages/bill-splits-page.js
// Split a bill among people — you pay, they each owe their share. Reuses
// the People module for all debt tracking, so settling up happens from
// the People page like any other lending.
// ==========================================================================

import { getBillSplits, createBillSplit, reverseBillSplit } from '../modules/bill-splits.js';
import { getPeople } from '../modules/people.js';
import { getAccounts } from '../modules/accounts.js';
import { getCategories } from '../modules/categories.js';
import { formatCurrency, roundMoney } from '../utils/currency.js';
import { formatDate, escapeHtml, qs, bindRowActivation } from '../utils/dom.js';
import { icons } from '../utils/icons.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { toast } from '../core/toast.js';
import { ValidationError } from '../core/ledger.js';

let container = null;

export async function renderBillSplitsPage(root) {
  container = root;
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <h1>Bill Splits</h1>
          <p class="page-subtitle">Split an expense with others — settle up from the People page.</p>
        </div>
        <button class="btn btn-primary" id="btn-add-split">${icons.plus} Split a Bill</button>
      </div>
      <div class="list" id="splits-list"></div>
    </div>
  `;

  qs('#btn-add-split', root).addEventListener('click', () => openSplitModal());
  await refresh();
}

async function refresh() {
  const splits = await getBillSplits();
  const listEl = qs('#splits-list', container);

  if (splits.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><h3>No bill splits yet</h3><p>Split a shared expense — everyone's portion shows up on the People page as money they owe you.</p></div>`;
    return;
  }

  listEl.innerHTML = splits.map((s) => splitRow(s)).join('');
  listEl.querySelectorAll('[data-id]').forEach((row) => {
    bindRowActivation(row, () => {
      const split = splits.find((s) => s.id === row.dataset.id);
      openDetailModal(split);
    });
  });
}

function splitRow(s) {
  return `
    <div class="list-row" data-id="${s.id}">
      <div class="row-icon">${icons.people}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(s.description)}</div>
        <div class="row-sub">${formatDate(s.date)} · Split ${s.participants.length + 1} ways</div>
      </div>
      <span class="amount num">${formatCurrency(s.totalAmount)}</span>
    </div>
  `;
}

async function openDetailModal(split) {
  const people = await getPeople({ includeArchived: true });
  const nameFor = (id) => people.find((p) => p.id === id)?.name || 'Unknown';

  openModal({
    title: escapeHtml(split.description),
    bodyHtml: `
      <p class="text-sm text-muted mb-3">${formatDate(split.date)} · Total ${formatCurrency(split.totalAmount)}</p>
      <div class="summary-list">
        <div class="summary-row"><span class="summary-label">Your share</span><span class="summary-value num">${formatCurrency(split.yourShare)}</span></div>
        ${split.participants.map((p) => `
          <div class="summary-row"><span class="summary-label">${escapeHtml(nameFor(p.personId))}</span><span class="summary-value num">${formatCurrency(p.amount)}</span></div>
        `).join('')}
      </div>
    `,
    actions: [
      { label: 'Reverse Split', variant: 'btn-danger', onClick: async (close) => {
          const ok = await confirmDialog({ title: 'Reverse this split?', message: 'This undoes the expense and everyone\'s share. Only works if nobody has repaid yet.', danger: true, confirmLabel: 'Reverse' });
          if (!ok) return;
          try {
            await reverseBillSplit(split.id);
            close();
            toast.success('Split reversed.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Something went wrong.');
          }
        } },
      { label: 'Close', variant: 'btn-ghost', onClick: (close) => close() },
    ],
  });
}

async function openSplitModal() {
  const [accounts, people, expenseCats] = await Promise.all([getAccounts(), getPeople(), getCategories('expense')]);
  if (accounts.length === 0) { toast.warning('Add an account first.'); return; }
  if (people.length === 0) { toast.warning('Add at least one person to split with first.'); return; }

  let selectedPeople = [];

  openModal({
    title: 'Split a Bill',
    size: 'lg',
    bodyHtml: `
      <div class="field">
        <label for="sp-desc">Description</label>
        <input class="input" id="sp-desc" type="text" placeholder="e.g. Dinner at restaurant" />
      </div>
      <div class="field-row">
        <div class="field">
          <label for="sp-amount">Total amount</label>
          <input class="input" id="sp-amount" type="number" min="0.01" step="0.01" />
        </div>
        <div class="field">
          <label for="sp-category">Category</label>
          <select class="select" id="sp-category">${expenseCats.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('')}</select>
        </div>
      </div>
      <div class="field">
        <label for="sp-account">Paid from</label>
        <select class="select" id="sp-account">${accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}</select>
      </div>
      <div class="field">
        <label>Split with</label>
        <div style="display:flex; flex-direction:column; gap: var(--sp-1); max-height:150px; overflow-y:auto;">
          ${people.map((p) => `
            <label style="display:flex; align-items:center; gap: var(--sp-2); font-size: var(--fs-sm);">
              <input type="checkbox" data-person="${p.id}" /> ${escapeHtml(p.name)}
            </label>
          `).join('')}
        </div>
      </div>
      <div class="field mb-0">
        <label style="display:flex; align-items:center; gap: var(--sp-2);">
          <input type="checkbox" id="sp-equal" checked /> Split equally (including your own share)
        </label>
      </div>
      <div id="sp-shares-container"></div>
      <p class="text-sm text-muted mt-2" id="sp-summary"></p>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Save Split',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const description = qs('#sp-desc', root).value.trim();
          const totalAmount = Number(qs('#sp-amount', root).value);
          const category = qs('#sp-category', root).value;
          const accountId = qs('#sp-account', root).value;
          const checked = [...root.querySelectorAll('[data-person]:checked')].map((el) => el.dataset.person);
          const isEqual = qs('#sp-equal', root).checked;

          if (checked.length === 0) { toast.error('Select at least one person.'); return; }

          let participants;
          if (isEqual) {
            const perShare = roundMoney(totalAmount / (checked.length + 1));
            participants = checked.map((personId) => ({ personId, amount: perShare }));
          } else {
            participants = checked.map((personId) => ({
              personId,
              amount: Number(root.querySelector(`[data-share="${personId}"]`)?.value || 0),
            }));
          }

          try {
            await createBillSplit({ description, category, totalAmount, accountId, participants });
            close();
            toast.success('Bill split recorded.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Something went wrong.');
          }
        },
      },
    ],
    onMount: (root) => {
      const updateSharesUI = () => {
        const checked = [...root.querySelectorAll('[data-person]:checked')].map((el) => ({ id: el.dataset.person, name: people.find((p) => p.id === el.dataset.person)?.name }));
        const isEqual = qs('#sp-equal', root).checked;
        const totalAmount = Number(qs('#sp-amount', root).value) || 0;

        const sharesContainer = qs('#sp-shares-container', root);
        if (isEqual || checked.length === 0) {
          sharesContainer.innerHTML = '';
        } else {
          sharesContainer.innerHTML = `
            <p class="text-xs text-faint mb-1">Enter each person's share:</p>
            ${checked.map((p) => `
              <div class="field" style="margin-bottom: var(--sp-2);">
                <label style="font-size:var(--fs-xs);">${escapeHtml(p.name)}</label>
                <input class="input" type="number" min="0" step="0.01" data-share="${p.id}" />
              </div>
            `).join('')}
          `;
        }

        if (isEqual && checked.length > 0 && totalAmount > 0) {
          const perShare = roundMoney(totalAmount / (checked.length + 1));
          qs('#sp-summary', root).textContent = `Your share: ${formatCurrency(perShare)} · Each person: ${formatCurrency(perShare)}`;
        } else {
          qs('#sp-summary', root).textContent = '';
        }
      };

      root.querySelectorAll('[data-person]').forEach((cb) => cb.addEventListener('change', updateSharesUI));
      qs('#sp-equal', root).addEventListener('change', updateSharesUI);
      qs('#sp-amount', root).addEventListener('input', updateSharesUI);
    },
  });
}
