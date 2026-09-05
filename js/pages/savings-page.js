// ==========================================================================
// Finora — pages/savings-page.js
// ==========================================================================

import {
  getGoals, getGoalById, goalProgress, createGoal,
  contribute, withdraw, getContributionHistory, archiveGoal, unarchiveGoal,
} from '../modules/savings.js';
import { getAccounts } from '../modules/accounts.js';
import { ValidationError } from '../core/ledger.js';
import { formatCurrency } from '../utils/currency.js';
import { formatDate, escapeHtml, qs, bindRowActivation } from '../utils/dom.js';
import { icons } from '../utils/icons.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { toast } from '../core/toast.js';

let container = null;

export async function renderSavingsPage(root, params) {
  container = root;
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Savings</h1>
        <button class="btn btn-primary" id="btn-add-goal">${icons.plus} Add Goal</button>
      </div>
      <div class="grid grid-cards" id="goals-grid"></div>
    </div>
  `;
  qs('#btn-add-goal', root).addEventListener('click', openCreateModal);
  await refresh();

  const openId = params?.get?.('open');
  if (openId) openGoalDetail(openId);
}

async function refresh() {
  const goals = await getGoals({ includeArchived: true });
  const gridEl = qs('#goals-grid', container);

  if (goals.length === 0) {
    gridEl.innerHTML = `
      <div class="empty-state" style="grid-column: 1/-1;">
        <h3>No savings goals yet</h3>
        <p>Set a target and start setting money aside for it.</p>
        <button class="btn btn-primary" id="btn-add-goal-empty">${icons.plus} Add Goal</button>
      </div>`;
    qs('#btn-add-goal-empty', gridEl).addEventListener('click', openCreateModal);
    return;
  }

  gridEl.innerHTML = goals.map((g) => {
    const { percent } = goalProgress(g);
    return `
      <div class="card is-clickable" data-id="${g.id}" style="cursor:pointer;">
        <div style="display:flex; align-items:center; gap: var(--sp-2); margin-bottom: var(--sp-3);">
          <div class="row-icon">${icons.savings}</div>
          <div>
            <div class="row-title">${escapeHtml(g.name)} ${g.archived ? '<span class="badge badge-neutral">Archived</span>' : ''}</div>
            <div class="row-sub">${formatCurrency(g.currentAmount)} of ${formatCurrency(g.targetAmount)}</div>
          </div>
        </div>
        <div class="progress-track"><div class="progress-fill ${percent >= 100 ? 'is-complete' : ''}" style="width:${percent}%;"></div></div>
      </div>
    `;
  }).join('');

  gridEl.querySelectorAll('.card[data-id]').forEach((card) => {
    bindRowActivation(card, () => openGoalDetail(card.dataset.id));
  });
}

function openCreateModal() {
  openModal({
    title: 'Add Savings Goal',
    bodyHtml: `
      <div class="field">
        <label for="g-name">Goal name</label>
        <input class="input" id="g-name" type="text" placeholder="e.g. Emergency Fund" required />
      </div>
      <div class="field">
        <label for="g-target">Target amount</label>
        <input class="input" id="g-target" type="number" min="1" step="0.01" required />
      </div>
      <div class="field-row">
        <div class="field">
          <label for="g-date">Target date (optional)</label>
          <input class="input" id="g-date" type="date" />
        </div>
        <div class="field">
          <label for="g-priority">Priority</label>
          <select class="select" id="g-priority">
            <option value="low">Low</option>
            <option value="medium" selected>Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Add Goal',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const name = qs('#g-name', root).value;
          const targetAmount = qs('#g-target', root).value;
          const dateVal = qs('#g-date', root).value;
          const targetDate = dateVal ? new Date(dateVal).toISOString() : undefined;
          const priority = qs('#g-priority', root).value;
          try {
            await createGoal({ name, targetAmount, targetDate, priority });
            close();
            toast.success('Goal added.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Something went wrong.');
          }
        },
      },
    ],
  });
}

async function openGoalDetail(id) {
  const goal = await getGoalById(id);
  if (!goal) return;
  const history = await getContributionHistory(id);
  const { percent, remaining } = goalProgress(goal);

  const historyHtml = history.length ? history.slice(0, 10).map((h) => `
    <div class="list-row">
      <div class="row-main">
        <div class="row-title">${escapeHtml(h.description || (h.direction === 'contribution' ? 'Contribution' : 'Withdrawal'))}</div>
        <div class="row-sub">${formatDate(h.date)}</div>
      </div>
      <span class="amount num amount--${h.direction === 'contribution' ? 'in' : 'out'}">${h.direction === 'contribution' ? '+' : '-'}${formatCurrency(h.amount)}</span>
    </div>
  `).join('') : `<div class="empty-state"><h3>No activity yet</h3></div>`;

  openModal({
    title: goal.name,
    bodyHtml: `
      <div class="card stat-card" style="margin-bottom: var(--sp-4);">
        <span class="stat-label">Progress</span>
        <span class="amount amount--lg num">${formatCurrency(goal.currentAmount)} <span class="text-sm text-muted">/ ${formatCurrency(goal.targetAmount)}</span></span>
        <div class="progress-track" style="margin-top: var(--sp-2);"><div class="progress-fill ${percent >= 100 ? 'is-complete' : ''}" style="width:${percent}%;"></div></div>
        <span class="text-xs text-faint">${remaining > 0 ? `${formatCurrency(remaining)} to go` : 'Target reached'}${goal.targetDate ? ` · Target date ${formatDate(goal.targetDate)}` : ''}</span>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap: var(--sp-2); margin-bottom: var(--sp-4);">
        <button class="btn btn-secondary btn-sm" id="act-contribute">Contribute</button>
        <button class="btn btn-secondary btn-sm" id="act-withdraw">Withdraw</button>
      </div>
      <div class="list">${historyHtml}</div>
    `,
    actions: [
      ...(goal.archived
        ? [{ label: 'Unarchive', variant: 'btn-secondary', onClick: async (close) => { await unarchiveGoal(id); close(); toast.success('Restored.'); refresh(); } }]
        : [{ label: 'Archive', variant: 'btn-secondary', onClick: async (close) => {
              const ok = await confirmDialog({ title: 'Archive goal', message: `Hide "${goal.name}"? History is kept.` });
              if (ok) { await archiveGoal(id); close(); toast.success('Archived.'); refresh(); }
            } }]),
      { label: 'Close', variant: 'btn-ghost', onClick: (close) => close() },
    ],
    onMount: (root) => {
      qs('#act-contribute', root).addEventListener('click', () => openMoneyModal(goal, 'contribute'));
      qs('#act-withdraw', root).addEventListener('click', () => openMoneyModal(goal, 'withdraw'));
    },
  });
}

async function openMoneyModal(goal, kind) {
  const accounts = await getAccounts();
  if (accounts.length === 0) {
    toast.warning('Add an account first.');
    return;
  }
  const options = accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  const isContribute = kind === 'contribute';

  openModal({
    title: isContribute ? `Contribute · ${goal.name}` : `Withdraw · ${goal.name}`,
    bodyHtml: `
      <div class="field">
        <label for="mm-account">${isContribute ? 'From account' : 'To account'}</label>
        <select class="select" id="mm-account">${options}</select>
      </div>
      <div class="field">
        <label for="mm-amount">Amount</label>
        <input class="input" id="mm-amount" type="number" min="0.01" step="0.01" required />
      </div>
      <div class="field">
        <label for="mm-desc">Description (optional)</label>
        <input class="input" id="mm-desc" type="text" />
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: isContribute ? 'Contribute' : 'Withdraw',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const accountId = qs('#mm-account', root).value;
          const amount = Number(qs('#mm-amount', root).value);
          const description = qs('#mm-desc', root).value;
          try {
            if (isContribute) await contribute(goal.id, { accountId, amount, description });
            else await withdraw(goal.id, { accountId, amount, description });
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
