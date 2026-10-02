// ==========================================================================
// Finora — pages/recurring-page.js
// ==========================================================================

import {
  getRules, getDueRules, getUpcomingRules, createRule,
  recordPayment, skipOccurrence, setRuleActive, deleteRule,
} from '../modules/recurring.js';
import { getAccounts } from '../modules/accounts.js';
import { getCategories, createCategory } from '../modules/categories.js';
import { ValidationError } from '../core/ledger.js';
import { formatCurrency } from '../utils/currency.js';
import { formatDate, escapeHtml, qs, bindRowActivation } from '../utils/dom.js';
import { icons } from '../utils/icons.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { toast } from '../core/toast.js';

let container = null;

const FREQ_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };

function frequencyText(rule) {
  return rule.frequencyMode === 'validity' ? `Every ${rule.intervalDays} days` : FREQ_LABEL[rule.frequency];
}

export async function renderRecurringPage(root) {
  container = root;
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Recurring</h1>
        <button class="btn btn-primary" id="btn-add-rule">${icons.plus} Add Rule</button>
      </div>
      <div id="due-section"></div>
      <h2 style="font-size: var(--fs-md); font-weight: 650; margin: var(--sp-5) 0 var(--sp-3);">All Rules</h2>
      <div class="list" id="rules-list"></div>
    </div>
  `;
  qs('#btn-add-rule', root).addEventListener('click', openCreateModal);
  await refresh();
}

async function refresh() {
  const [due, upcoming, allRules] = await Promise.all([getDueRules(), getUpcomingRules(7), getRules()]);
  renderDueSection(due, upcoming);
  renderRulesList(allRules);
}

function renderDueSection(due, upcoming) {
  const el = qs('#due-section', container);
  if (due.length === 0 && upcoming.length === 0) { el.innerHTML = ''; return; }

  const dueRows = due.map((r) => `
    <div class="list-row">
      <div class="row-icon">${icons.recurring}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(r.name)} expected — Record ${formatCurrency(r.amount)}?</div>
        <div class="row-sub">Due ${formatDate(r.nextDueDate)} · ${frequencyText(r)}</div>
      </div>
      <div class="row-trail">
        <button class="btn btn-secondary btn-sm" data-skip="${r.id}">Skip</button>
        <button class="btn btn-primary btn-sm" data-pay="${r.id}">Record Payment</button>
      </div>
    </div>
  `).join('');

  const upcomingRows = upcoming.map((r) => `
    <div class="list-row">
      <div class="row-icon">${icons.recurring}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(r.name)}</div>
        <div class="row-sub">Due ${formatDate(r.nextDueDate)} · ${frequencyText(r)}</div>
      </div>
      <span class="amount num">${formatCurrency(r.amount)}</span>
    </div>
  `).join('');

  el.innerHTML = `
    ${due.length ? `<h2 class="section-title">Due</h2><div class="list">${dueRows}</div>` : ''}
    ${upcoming.length ? `<h2 style="font-size: var(--fs-md); font-weight: 650; margin: var(--sp-4) 0 var(--sp-3);">Coming Up</h2><div class="list">${upcomingRows}</div>` : ''}
  `;

  el.querySelectorAll('[data-pay]').forEach((btn) => btn.addEventListener('click', async () => {
    const rule = due.find((r) => r.id === btn.dataset.pay);
    openRecordModal(rule);
  }));
  el.querySelectorAll('[data-skip]').forEach((btn) => btn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Skip this occurrence', message: 'This advances the due date without recording a payment.' });
    if (ok) { await skipOccurrence(btn.dataset.skip); toast.success('Skipped.'); refresh(); }
  }));
}

function renderRulesList(rules) {
  const listEl = qs('#rules-list', container);
  if (rules.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><h3>No recurring rules yet</h3><p>Add one for a subscription, bill, or recharge.</p></div>`;
    return;
  }

  listEl.innerHTML = rules.map((r) => `
    <div class="list-row is-clickable" data-id="${r.id}">
      <div class="row-icon">${icons[r.type] || icons.recurring}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(r.name)} ${!r.active ? '<span class="badge badge-neutral">Paused</span>' : ''}</div>
        <div class="row-sub">${frequencyText(r)} · Next ${formatDate(r.nextDueDate)}</div>
      </div>
      <span class="amount num ${r.type === 'income' ? 'amount--in' : 'amount--out'}">${formatCurrency(r.amount)}</span>
    </div>
  `).join('');

  listEl.querySelectorAll('.list-row').forEach((row) => {
    bindRowActivation(row, () => openRuleActions(rules.find((r) => r.id === row.dataset.id)));
  });
}

function openRuleActions(rule) {
  openModal({
    title: rule.name,
    bodyHtml: `
      <p class="text-sm text-muted">${frequencyText(rule)} · ${formatCurrency(rule.amount)} · Next due ${formatDate(rule.nextDueDate)}</p>
      ${rule.lastPaidDate ? `<p class="text-xs text-faint" style="margin-top:var(--sp-2);">Last recorded ${formatDate(rule.lastPaidDate)}</p>` : ''}
    `,
    actions: [
      { label: 'Delete', variant: 'btn-danger', onClick: async (close) => {
          const ok = await confirmDialog({ title: 'Delete rule', message: 'This only removes the reminder — any already-recorded payments stay in your history.', danger: true, confirmLabel: 'Delete' });
          if (ok) { await deleteRule(rule.id); close(); toast.success('Rule deleted.'); refresh(); }
        } },
      { label: rule.active ? 'Pause' : 'Resume', variant: 'btn-secondary', onClick: async (close) => {
          await setRuleActive(rule.id, !rule.active); close(); toast.success(rule.active ? 'Paused.' : 'Resumed.'); refresh();
        } },
      { label: 'Record Payment', variant: 'btn-primary', onClick: (close) => { close(); openRecordModal(rule); } },
    ],
  });
}

function openRecordModal(rule) {
  getAccounts().then((accounts) => {
    const options = accounts.map((a) => `<option value="${a.id}" ${a.id === rule.accountId ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');
    openModal({
      title: `Record ${rule.name}`,
      bodyHtml: `
        <p class="text-sm mb-3">${rule.name} expected — record ${formatCurrency(rule.amount)}?</p>
        <div class="field">
          <label for="rp-account">Account</label>
          <select class="select" id="rp-account">${options}</select>
        </div>
        <div class="field">
          <label for="rp-amount">Amount</label>
          <input class="input" id="rp-amount" type="number" min="0.01" step="0.01" value="${rule.amount}" />
        </div>
        <div class="field">
          <label for="rp-date">Payment date</label>
          <input class="input" id="rp-date" type="date" value="${new Date().toISOString().slice(0, 10)}" />
        </div>
      `,
      actions: [
        { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
        {
          label: 'Record Payment',
          variant: 'btn-primary',
          onClick: async (close, root) => {
            const accountId = qs('#rp-account', root).value;
            const amount = Number(qs('#rp-amount', root).value);
            const dateVal = qs('#rp-date', root).value;
            const date = dateVal ? new Date(dateVal).toISOString() : undefined;
            try {
              await recordPayment(rule.id, { accountId, amount, date });
              close();
              toast.success('Payment recorded.');
              refresh();
            } catch (err) {
              toast.error(err instanceof ValidationError ? err.message : 'Something went wrong.');
            }
          },
        },
      ],
    });
  });
}

async function openCreateModal() {
  const accounts = await getAccounts();
  if (accounts.length === 0) {
    toast.warning('Add an account first.');
    return;
  }
  const accountOptions = accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');

  openModal({
    title: 'Add Recurring Rule',
    bodyHtml: `
      <form id="form-rule">
        <div class="field">
          <label for="r-name">Name</label>
          <input class="input" id="r-name" type="text" placeholder="e.g. Netflix" required />
        </div>
        <div class="field-row">
          <div class="field">
            <label for="r-type">Type</label>
            <select class="select" id="r-type">
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select>
          </div>
          <div class="field">
            <label for="r-amount">Amount</label>
            <input class="input" id="r-amount" type="number" min="0.01" step="0.01" required />
          </div>
        </div>
        <div class="field">
          <label for="r-account">Account</label>
          <select class="select" id="r-account">${accountOptions}</select>
        </div>
        <div class="field">
          <label for="r-category">Category (optional)</label>
          <select class="select" id="r-category"><option value="">No category</option></select>
        </div>
        <div class="field">
          <label style="display:flex; align-items:center; gap: var(--sp-2); font-weight:500;">
            <input type="checkbox" id="r-validity" /> Validity-based (e.g. recharge), not calendar month
          </label>
        </div>
        <div class="field" id="r-freq-field">
          <label for="r-frequency">Frequency</label>
          <select class="select" id="r-frequency">
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
            <option value="daily">Daily</option>
            <option value="yearly">Yearly</option>
          </select>
        </div>
        <div class="field hidden" id="r-interval-field">
          <label for="r-interval">Validity (days)</label>
          <input class="input" id="r-interval" type="number" min="1" step="1" placeholder="e.g. 28" />
        </div>
        <div class="field">
          <label for="r-start">First due date</label>
          <input class="input" id="r-start" type="date" value="${new Date().toISOString().slice(0, 10)}" />
        </div>
      </form>
    `,
    onMount: async (root) => {
      const loadCategories = async () => {
        const type = qs('#r-type', root).value;
        const cats = await getCategories(type);
        qs('#r-category', root).innerHTML = '<option value="">No category</option>' + cats.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
      };
      qs('#r-type', root).addEventListener('change', loadCategories);
      await loadCategories();

      qs('#r-validity', root).addEventListener('change', (e) => {
        qs('#r-freq-field', root).classList.toggle('hidden', e.target.checked);
        qs('#r-interval-field', root).classList.toggle('hidden', !e.target.checked);
      });
    },
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Add Rule',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const name = qs('#r-name', root).value;
          const type = qs('#r-type', root).value;
          const amount = qs('#r-amount', root).value;
          const accountId = qs('#r-account', root).value;
          const category = qs('#r-category', root).value || undefined;
          const isValidity = qs('#r-validity', root).checked;
          const frequency = qs('#r-frequency', root).value;
          const intervalDays = qs('#r-interval', root).value;
          const startVal = qs('#r-start', root).value;
          const startDate = startVal ? new Date(startVal).toISOString() : undefined;

          try {
            await createRule({
              name, type, amount, accountId, category,
              frequencyMode: isValidity ? 'validity' : 'calendar',
              frequency, intervalDays, startDate,
            });
            close();
            toast.success('Recurring rule added.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Something went wrong.');
          }
        },
      },
    ],
  });
}
