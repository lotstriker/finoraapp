// ==========================================================================
// Finora — pages/budgets-page.js
// Monthly Budgets: set a per-category spending limit, see progress
// against it for the current calendar month at a glance.
// ==========================================================================

import { getBudgets, setBudget, deleteBudget, getBudgetProgress } from '../modules/budgets.js';
import { getCategories } from '../modules/categories.js';
import { formatCurrency } from '../utils/currency.js';
import { escapeHtml, qs, bindRowActivation } from '../utils/dom.js';
import { icons } from '../utils/icons.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { toast } from '../core/toast.js';

let container = null;

export async function renderBudgetsPage(root) {
  container = root;
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <h1>Budgets</h1>
          <p class="page-subtitle">Monthly spending limits per category — resets automatically each calendar month.</p>
        </div>
        <button class="btn btn-primary" id="btn-add-budget">${icons.plus} Set a Budget</button>
      </div>
      <div class="list" id="budgets-list"></div>
    </div>
  `;

  qs('#btn-add-budget', root).addEventListener('click', () => openBudgetModal());
  await refresh();
}

async function refresh() {
  const progress = await getBudgetProgress();
  const listEl = qs('#budgets-list', container);

  if (progress.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><h3>No budgets set</h3><p>Set a monthly limit for a category to start tracking against it.</p></div>`;
    return;
  }

  listEl.innerHTML = progress.map((b) => budgetRow(b)).join('');
  listEl.querySelectorAll('[data-id]').forEach((row) => {
    bindRowActivation(row, () => {
      const budget = progress.find((p) => p.id === row.dataset.id);
      openBudgetModal(budget);
    });
  });
}

function budgetRow(b) {
  const barColor = b.overLimit ? 'var(--color-danger)' : b.percentUsed >= 80 ? 'var(--color-warning)' : 'var(--color-success)';
  const pct = Math.min(100, b.percentUsed);
  return `
    <div class="list-row" data-id="${b.id}" style="flex-direction:column; align-items:stretch; gap: var(--sp-2);">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div class="row-title">${escapeHtml(b.category)}</div>
        <div class="text-sm ${b.overLimit ? 'amount--out' : 'text-muted'}">${formatCurrency(b.spent)} / ${formatCurrency(b.monthlyLimit)}</div>
      </div>
      <div style="background: var(--color-border); border-radius: 999px; height: 8px; overflow: hidden;">
        <div style="width: ${pct}%; height: 100%; background: ${barColor}; border-radius: 999px;"></div>
      </div>
      ${b.overLimit ? `<div class="text-xs" style="color: var(--color-danger);">Over budget by ${formatCurrency(Math.abs(b.remaining))}</div>` : `<div class="text-xs text-faint">${formatCurrency(b.remaining)} remaining this month</div>`}
    </div>
  `;
}

async function openBudgetModal(existing) {
  const expenseCats = await getCategories('expense');
  const existingBudgets = await getBudgets();
  const usedCategories = new Set(existingBudgets.map((b) => b.category).filter((c) => c !== existing?.category));
  const availableCats = expenseCats.filter((c) => !usedCategories.has(c.name));

  if (!existing && availableCats.length === 0) {
    toast.warning('Every expense category already has a budget.');
    return;
  }

  openModal({
    title: existing ? `Edit Budget · ${existing.category}` : 'Set a Budget',
    bodyHtml: `
      <div class="field">
        <label for="bg-category">Category</label>
        <select class="select" id="bg-category" ${existing ? 'disabled' : ''}>
          ${(existing ? [existing] : availableCats).map((c) => `<option value="${escapeHtml(existing ? existing.category : c.name)}">${escapeHtml(existing ? existing.category : c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field mb-0">
        <label for="bg-limit">Monthly limit</label>
        <input class="input" id="bg-limit" type="number" min="0.01" step="0.01" value="${existing ? existing.monthlyLimit : ''}" autofocus />
      </div>
    `,
    actions: [
      ...(existing ? [{ label: 'Delete', variant: 'btn-danger', onClick: async (close) => {
          const ok = await confirmDialog({ title: 'Delete budget', message: `Remove the budget for "${existing.category}"?` });
          if (ok) { await deleteBudget(existing.id); close(); toast.success('Budget deleted.'); refresh(); }
        } }] : []),
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: existing ? 'Save' : 'Set Budget',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const category = qs('#bg-category', root).value;
          const monthlyLimit = Number(qs('#bg-limit', root).value);
          try {
            await setBudget({ category, monthlyLimit });
            close();
            toast.success('Budget saved.');
            refresh();
          } catch (err) {
            toast.error(err.message || 'Something went wrong.');
          }
        },
      },
    ],
  });
}
