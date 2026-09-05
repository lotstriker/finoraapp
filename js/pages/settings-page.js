// ==========================================================================
// Finora — pages/settings-page.js
// Reorganized into clear groups: Appearance, Preferences, Modules,
// Data & Privacy (Categories, Backup/Restore, Export, Delete All Data).
// ==========================================================================

import { getAccounts } from '../modules/accounts.js';
import { createEncryptedBackup, decryptBackup, restoreBackup, downloadTextFile, exportCsv, deleteAllData } from '../modules/backup.js';
import { getSetting, setSetting, getEnabledModules, setModuleEnabled, OPTIONAL_MODULES } from '../modules/preferences.js';
import { getCategories, archiveCategory, unarchiveCategory } from '../modules/categories.js';
import { getTheme, setTheme, getColorTheme, setColorTheme, COLOR_THEMES } from '../utils/theme.js';
import { getCurrencyPreference, setCurrencyPreference, CURRENCIES } from '../utils/currency.js';
import { qs } from '../utils/dom.js';
import { icons } from '../utils/icons.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { toast } from '../core/toast.js';

const DEFAULT_ACCOUNT_KEY = 'defaultAccountId';
const MODULE_LABELS = { people: 'People', loans: 'Loans & EMI', bidsave: 'Bid & Save', savings: 'Savings', recurring: 'Recurring' };

export async function renderSettingsPage(root) {
  const accounts = await getAccounts();
  const defaultAccountId = await getSetting(DEFAULT_ACCOUNT_KEY);
  const currentTheme = getTheme();
  const enabledModules = await getEnabledModules();

  root.innerHTML = `
    <div class="page">
      <div class="page-header"><h1>Settings</h1></div>

      <h2 class="settings-group-title">Appearance</h2>
      <div class="card" style="margin-bottom: var(--sp-5);">
        <div class="field">
          <label for="st-theme">Theme</label>
          <select class="select" id="st-theme" style="max-width:220px;">
            <option value="light" ${currentTheme === 'light' ? 'selected' : ''}>Light</option>
            <option value="dark" ${currentTheme === 'dark' ? 'selected' : ''}>Dark</option>
            <option value="system" ${currentTheme === 'system' ? 'selected' : ''}>System</option>
          </select>
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Color theme</label>
          <div class="swatch-grid" id="st-color-swatches">
            ${COLOR_THEMES.map((c) => `
              <button type="button" class="swatch-btn ${c.value === getColorTheme() ? 'active' : ''}" data-color-theme="${c.value}">
                <span class="swatch-dot" style="background:${c.swatch};"></span>
                <span>${c.label}</span>
              </button>
            `).join('')}
          </div>
        </div>
      </div>

      <h2 class="settings-group-title">Preferences</h2>
      <div class="card" style="margin-bottom: var(--sp-5);">
        <div class="field">
          <label for="st-currency">Currency</label>
          <select class="select" id="st-currency" style="max-width:220px;">
            ${CURRENCIES.map((c) => `<option value="${c.code}" ${c.code === getCurrencyPreference() ? 'selected' : ''}>${c.symbol} ${c.label}</option>`).join('')}
          </select>
          <span class="field-hint">Changes how amounts are displayed. Doesn't convert existing amounts.</span>
        </div>
        <div class="field" style="margin-bottom:0;">
          <label for="st-default-account">Default account (pre-selected in forms)</label>
          <select class="select" id="st-default-account" style="max-width:280px;">
            <option value="">No default</option>
            ${accounts.map((a) => `<option value="${a.id}" ${a.id === defaultAccountId ? 'selected' : ''}>${a.name}</option>`).join('')}
          </select>
        </div>
      </div>

      <h2 class="settings-group-title">Modules</h2>
      <div class="card" style="margin-bottom: var(--sp-5);">
        <p class="text-sm text-muted" style="margin-bottom: var(--sp-3);">Turn off what you don't use. Their data is kept — turning one back on brings its history right back.</p>
        <div style="display:flex; flex-direction:column; gap: var(--sp-2);">
          ${OPTIONAL_MODULES.map((m) => `
            <label style="display:flex; align-items:center; gap: var(--sp-2); font-size: var(--fs-sm);">
              <input type="checkbox" data-module="${m}" ${enabledModules[m] ? 'checked' : ''} /> ${MODULE_LABELS[m]}
            </label>
          `).join('')}
        </div>
      </div>

      <h2 class="settings-group-title">Data &amp; Privacy</h2>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-1);">Categories</h3>
        <p class="text-sm text-muted" style="margin-bottom: var(--sp-3);">Archived categories stay out of Income/Expense forms but past transactions keep their history.</p>
        <div id="st-categories"></div>
      </div>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-1);">Backup &amp; Restore</h3>
        <p class="text-sm text-muted" style="margin-bottom: var(--sp-3);">Your data lives only on this device. Back it up regularly — encrypted with a password only you know.</p>
        <div style="display:flex; gap: var(--sp-2); flex-wrap:wrap;">
          <button class="btn btn-primary" id="btn-backup">${icons.archive} Create Backup</button>
          <button class="btn btn-secondary" id="btn-restore">Restore from Backup</button>
        </div>
      </div>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-1);">Export</h3>
        <p class="text-sm text-muted" style="margin-bottom: var(--sp-3);">Plain CSV files for spreadsheets — not encrypted, not a substitute for backup.</p>
        <div style="display:flex; gap: var(--sp-2); flex-wrap:wrap;">
          <button class="btn btn-secondary btn-sm" id="btn-export-txn">All Transactions</button>
          <button class="btn btn-secondary btn-sm" id="btn-export-income">Income Only</button>
          <button class="btn btn-secondary btn-sm" id="btn-export-expenses">Expenses Only</button>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-bottom: var(--sp-1); color: var(--color-danger);">Delete All Data</h3>
        <p class="text-sm text-muted" style="margin-bottom: var(--sp-3);">Permanently erases every account, transaction, and record in Finora on this device. This cannot be undone — back up first if you're not sure.</p>
        <button class="btn btn-danger" id="btn-delete-all">${icons.trash} Delete All Data</button>
      </div>
    </div>
  `;

  qs('#st-currency', root).addEventListener('change', async (e) => {
    setCurrencyPreference(e.target.value);
    toast.success('Currency updated.');
    await renderSettingsPage(root);
  });

  qs('#st-theme', root).addEventListener('change', (e) => {
    setTheme(e.target.value);
    toast.success('Theme updated.');
  });

  root.querySelectorAll('[data-color-theme]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setColorTheme(btn.dataset.colorTheme);
      root.querySelectorAll('.swatch-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      toast.success('Color theme updated.');
    });
  });

  root.querySelectorAll('[data-module]').forEach((cb) => {
    cb.addEventListener('change', async (e) => {
      await setModuleEnabled(e.target.dataset.module, e.target.checked);
      window.dispatchEvent(new CustomEvent('finora:modules-changed'));
      toast.success(`${MODULE_LABELS[e.target.dataset.module]} ${e.target.checked ? 'enabled' : 'disabled'}.`);
    });
  });

  qs('#st-default-account', root).addEventListener('change', async (e) => {
    await setSetting(DEFAULT_ACCOUNT_KEY, e.target.value || null);
    toast.success('Default account updated.');
  });

  qs('#btn-backup', root).addEventListener('click', openBackupModal);
  qs('#btn-restore', root).addEventListener('click', openRestoreModal);
  qs('#btn-export-txn', root).addEventListener('click', () => exportCsv('transactions').then(() => toast.success('Exported.')));
  qs('#btn-export-income', root).addEventListener('click', () => exportCsv('income').then(() => toast.success('Exported.')));
  qs('#btn-export-expenses', root).addEventListener('click', () => exportCsv('expenses').then(() => toast.success('Exported.')));
  qs('#btn-delete-all', root).addEventListener('click', openDeleteAllModal);

  await renderCategories(root);
}

async function renderCategories(root) {
  const [income, expense] = await Promise.all([
    getCategories('income', { includeArchived: true }),
    getCategories('expense', { includeArchived: true }),
  ]);

  const row = (c) => `
    <div class="list-row">
      <div class="row-main">
        <div class="row-title">${c.name} ${c.archived ? '<span class="badge badge-neutral">Archived</span>' : ''}</div>
      </div>
      <button class="btn btn-secondary btn-sm" data-cat-toggle="${c.id}" data-archived="${c.archived}">${c.archived ? 'Restore' : 'Archive'}</button>
    </div>
  `;

  qs('#st-categories', root).innerHTML = `
    <p class="text-xs text-faint" style="margin-bottom:var(--sp-1);">INCOME</p>
    <div class="list" style="margin-bottom: var(--sp-3);">${income.map(row).join('')}</div>
    <p class="text-xs text-faint" style="margin-bottom:var(--sp-1);">EXPENSE</p>
    <div class="list">${expense.map(row).join('')}</div>
  `;

  qs('#st-categories', root).querySelectorAll('[data-cat-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const isArchived = btn.dataset.archived === 'true';
      if (isArchived) await unarchiveCategory(btn.dataset.catToggle);
      else await archiveCategory(btn.dataset.catToggle);
      toast.success(isArchived ? 'Category restored.' : 'Category archived.');
      await renderCategories(root);
    });
  });
}

function openBackupModal() {
  openModal({
    title: 'Create Backup',
    bodyHtml: `
      <p class="text-sm" style="margin-bottom: var(--sp-3);">Choose a password. You'll need it to restore this backup later — Finora cannot recover it for you.</p>
      <div class="field">
        <label for="bk-pass">Password</label>
        <input class="input" id="bk-pass" type="password" minlength="8" required />
        <span class="field-hint">Minimum 8 characters.</span>
      </div>
      <div class="field">
        <label for="bk-pass2">Confirm password</label>
        <input class="input" id="bk-pass2" type="password" minlength="8" required />
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Create & Download',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const p1 = qs('#bk-pass', root).value;
          const p2 = qs('#bk-pass2', root).value;
          if (p1 !== p2) { toast.error('Passwords do not match.'); return; }
          try {
            const content = await createEncryptedBackup(p1);
            downloadTextFile(`finora-backup-${new Date().toISOString().slice(0, 10)}.finora`, content);
            close();
            toast.success('Backup downloaded.');
          } catch (err) {
            toast.error(err.message || 'Could not create the backup.');
          }
        },
      },
    ],
  });
}

function openRestoreModal() {
  openModal({
    title: 'Restore from Backup',
    bodyHtml: `
      <div class="field">
        <label for="rs-file">Backup file</label>
        <input class="input" id="rs-file" type="file" accept=".finora,.json,application/json" />
      </div>
      <div class="field">
        <label for="rs-pass">Password</label>
        <input class="input" id="rs-pass" type="password" required />
      </div>
      <div class="field" style="margin-bottom:0;">
        <label for="rs-mode">Mode</label>
        <select class="select" id="rs-mode">
          <option value="merge">Merge — keep existing data, add anything new</option>
          <option value="replace">Replace — clear everything, then restore</option>
        </select>
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Restore',
        variant: 'btn-danger',
        onClick: async (close, root) => {
          const fileInput = qs('#rs-file', root);
          const password = qs('#rs-pass', root).value;
          const mode = qs('#rs-mode', root).value;
          const file = fileInput.files[0];
          if (!file) { toast.error('Choose a backup file.'); return; }

          if (mode === 'replace') {
            const ok = await confirmDialog({
              title: 'Replace all data?',
              message: 'This clears everything currently in Finora before restoring. This cannot be undone.',
              danger: true,
              confirmLabel: 'Replace Everything',
            });
            if (!ok) return;
          }

          try {
            const text = await file.text();
            const payload = await decryptBackup(text, password);
            await restoreBackup(payload, mode);
            close();
            toast.success('Restore complete. Reloading…');
            setTimeout(() => location.reload(), 1200);
          } catch (err) {
            toast.error(err.message || 'Could not restore this backup.');
          }
        },
      },
    ],
  });
}

function openDeleteAllModal() {
  openModal({
    title: 'Delete All Data',
    bodyHtml: `
      <p class="text-sm" style="margin-bottom: var(--sp-3);">This permanently erases every account, transaction, committee, loan, goal, and person in Finora on this device. <strong>This cannot be undone.</strong></p>
      <div class="field" style="margin-bottom:0;">
        <label for="del-confirm">Type <strong>DELETE</strong> to confirm</label>
        <input class="input" id="del-confirm" type="text" autocomplete="off" />
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Delete Everything',
        variant: 'btn-danger',
        onClick: async (close, root) => {
          const typed = qs('#del-confirm', root).value;
          if (typed !== 'DELETE') { toast.error('Type DELETE exactly to confirm.'); return; }
          try {
            await deleteAllData();
            close();
            toast.success('All data deleted. Reloading…');
            setTimeout(() => location.reload(), 1000);
          } catch (err) {
            toast.error('Something went wrong deleting your data.');
          }
        },
      },
    ],
  });
}
