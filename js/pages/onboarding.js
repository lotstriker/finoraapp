// ==========================================================================
// Finora — pages/onboarding.js
// "Should not preload fake/demo financial data." Main Account balance is
// always ₹0 here — no opening-balance field (04).
// ==========================================================================

import { createAccount, ACCOUNT_TYPES } from '../modules/accounts.js';
import { setModuleEnabled, markOnboardingComplete, OPTIONAL_MODULES } from '../modules/preferences.js';
import { qs } from '../utils/dom.js';
import { openModal, closeModal } from '../core/modal.js';
import { toast } from '../core/toast.js';

const MODULE_LABELS = { people: 'People', loans: 'Loans & EMI', bidsave: 'Bid & Save', savings: 'Savings', recurring: 'Recurring' };

/** Runs the wizard and resolves once the user finishes or skips it entirely. */
export function runOnboarding() {
  return new Promise((resolve) => {
    stepWelcome(resolve);
  });
}

function stepWelcome(resolve) {
  openModal({
    title: 'Welcome to Finora',
    bodyHtml: `
      <p class="text-sm" style="line-height:1.6;">
        Finora keeps every rupee accounted for — accounts, income, expenses, loans, committees,
        savings goals and more, all stored privately on this device. Nothing here is fake demo data;
        everything you see is something you added.
      </p>
    `,
    actions: [
      { label: 'Skip Setup', variant: 'btn-ghost', onClick: async (close) => { close(); await finish(resolve); } },
      { label: 'Get Started', variant: 'btn-primary', onClick: (close) => { close(); stepCurrency(resolve); } },
    ],
  });
}

function stepCurrency(resolve) {
  openModal({
    title: 'Currency',
    bodyHtml: `
      <p class="text-sm">Finora uses the Indian Rupee for all amounts.</p>
      <div class="card stat-card" style="margin-top: var(--sp-3);">
        <span class="stat-label">Currency</span>
        <span class="amount amount--lg num">₹ INR</span>
      </div>
    `,
    actions: [
      { label: 'Continue', variant: 'btn-primary', onClick: (close) => { close(); stepMainAccount(resolve); } },
    ],
  });
}

function stepMainAccount(resolve) {
  const typeOptions = ACCOUNT_TYPES.filter((t) => t.value !== 'credit_card')
    .map((t) => `<option value="${t.value}">${t.label}</option>`).join('');

  openModal({
    title: 'Your Main Account',
    bodyHtml: `
      <p class="text-sm" style="margin-bottom: var(--sp-3);">Optional — you can always add accounts later. It starts at ₹0; use Add Money afterward if it already holds funds.</p>
      <div class="field">
        <label for="ob-name">Account name</label>
        <input class="input" id="ob-name" type="text" value="Main Account" />
      </div>
      <div class="field">
        <label for="ob-type">Type</label>
        <select class="select" id="ob-type">${typeOptions}</select>
      </div>
    `,
    actions: [
      { label: 'Skip', variant: 'btn-ghost', onClick: (close) => { close(); stepFeatures(resolve); } },
      {
        label: 'Create Account',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const name = qs('#ob-name', root).value || 'Main Account';
          const type = qs('#ob-type', root).value;
          try {
            await createAccount({ name, type, initialBalance: 0 });
            toast.success(`${name} created.`);
          } catch (err) {
            toast.error('Could not create the account — you can add it later from Accounts.');
          }
          close();
          stepFeatures(resolve);
        },
      },
    ],
  });
}

function stepFeatures(resolve) {
  openModal({
    title: 'Which modules do you need?',
    bodyHtml: `
      <p class="text-sm" style="margin-bottom: var(--sp-3);">Turn off anything you don't use — you can change this anytime in Settings. Your data is never deleted, just hidden.</p>
      <div style="display:flex; flex-direction:column; gap: var(--sp-2);">
        ${OPTIONAL_MODULES.map((m) => `
          <label style="display:flex; align-items:center; gap: var(--sp-2); font-size: var(--fs-sm);">
            <input type="checkbox" data-module="${m}" checked /> ${MODULE_LABELS[m]}
          </label>
        `).join('')}
      </div>
    `,
    actions: [
      {
        label: 'Finish',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const checkboxes = root.querySelectorAll('[data-module]');
          for (const cb of checkboxes) {
            await setModuleEnabled(cb.dataset.module, cb.checked);
          }
          close();
          await finish(resolve);
        },
      },
    ],
  });
}

async function finish(resolve) {
  await markOnboardingComplete();
  resolve();
}
