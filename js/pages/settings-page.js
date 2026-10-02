// ==========================================================================
// Finora — pages/settings-page.js
// Reorganized into clear groups: Appearance, Preferences, Modules,
// Data & Privacy (Categories, Backup/Restore, Export, Delete All Data).
// ==========================================================================

import { getAccounts } from '../modules/accounts.js';
import { createEncryptedBackup, decryptBackup, restoreBackup, downloadTextFile, exportCsv, deleteAllData, recordBackupCompleted, getBackupReminderStatus } from '../modules/backup.js';
import { isNotificationSupported, getPermission, requestPermission, getNotificationsEnabled, setNotificationsEnabled } from '../modules/notifications.js';
import { parseCsv, validateImportRows, importValidRows } from '../modules/csv-import.js';
import { getSetting, setSetting, getEnabledModules, setModuleEnabled, OPTIONAL_MODULES } from '../modules/preferences.js';
import { getCategories, archiveCategory, unarchiveCategory } from '../modules/categories.js';
import { getTheme, setTheme, ALL_THEMES } from '../utils/theme.js';
import { getProfiles, getActiveProfileId, createProfile, renameProfile, deleteProfile, switchProfile } from '../modules/profiles.js';
import { getCurrencyPreference, setCurrencyPreference, CURRENCIES, formatCurrency } from '../utils/currency.js';
import { qs, escapeHtml, formatDate } from '../utils/dom.js';
import { icons } from '../utils/icons.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { toast } from '../core/toast.js';
import { isGoogleConfigured, isConnected as isGoogleConnected, getConnectedEmail, connectGoogleAccount, disconnectGoogleAccount, getAccessToken, trySilentReconnect } from '../modules/google-auth.js';
import { backupToGoogleDrive, getGoogleDriveBackupInfo, restoreFromGoogleDrive } from '../modules/google-drive-backup.js';

const DEFAULT_ACCOUNT_KEY = 'defaultAccountId';
const MODULE_LABELS = { income: 'Income', expenses: 'Expenses', budgets: 'Budgets', scheduled: 'Scheduled', people: 'People', billsplits: 'Bill Splits', loans: 'Loans & EMI', bidsave: 'Bid & Save', savings: 'Savings', investments: 'Investments', recurring: 'Recurring' };

function themeSwatchColor(themeValue) {
  const swatches = {
    light: '#F5F5FC', dark: '#000000', system: 'linear-gradient(135deg, #F5F5FC 50%, #000000 50%)',
    'cyber-teal': '#00E599', 'neon-amber': '#FF661A', 'midnight-gold': '#FCA311',
    'deep-pine': '#45D49E', 'ocean-twilight': 'linear-gradient(180deg, #0F2027 0%, #00D2FF 100%)',
  };
  return swatches[themeValue] || '#999';
}

export async function renderSettingsPage(root) {
  const accounts = await getAccounts();
  const defaultAccountId = await getSetting(DEFAULT_ACCOUNT_KEY);
  const currentTheme = getTheme();
  const enabledModules = await getEnabledModules();
  const profiles = getProfiles();
  const activeProfileId = getActiveProfileId();

  root.innerHTML = `
    <div class="page">
      <div class="page-header"><h1>Settings</h1></div>

      <h2 class="settings-group-title">Household Profiles</h2>
      <div class="card mb-5">
        <p class="text-sm text-muted mb-3">Each profile has its own completely separate accounts and transactions — switching profiles reloads Finora into that profile's data.</p>
        <div class="list mb-3">
          ${profiles.map((p) => `
            <div class="list-row" data-profile-id="${p.id}">
              <div class="row-icon" style="font-size: 18px;">${p.emoji}</div>
              <div class="row-main">
                <div class="row-title">${escapeHtml(p.name)} ${p.id === activeProfileId ? '<span class="badge badge-success">Active</span>' : ''}</div>
              </div>
              ${p.id === activeProfileId
                ? ''
                : `<button class="btn btn-secondary btn-sm" data-switch-profile="${p.id}">Switch</button>`}
              <button class="btn btn-ghost btn-sm" data-rename-profile="${p.id}">Rename</button>
              ${profiles.length > 1 && p.id !== activeProfileId ? `<button class="btn btn-ghost btn-sm" data-delete-profile="${p.id}" style="color:var(--color-danger);">Delete</button>` : ''}
            </div>
          `).join('')}
        </div>
        <button class="btn btn-secondary btn-sm" id="btn-add-profile" ${profiles.length >= 6 ? 'disabled' : ''}>${icons.plus || ''} Add Profile</button>
        ${profiles.length >= 6 ? '<p class="text-xs text-faint mt-1">Up to 6 profiles.</p>' : ''}
      </div>

      <h2 class="settings-group-title">Appearance</h2>
      <div class="card mb-5">
        <div class="field mb-0">
          <label>Theme</label>
          <p class="text-xs text-faint mb-2">Pick one — selecting a theme replaces whichever was active before.</p>
          <div class="swatch-grid" id="st-theme-swatches">
            ${ALL_THEMES.map((t) => `
              <button type="button" class="swatch-btn ${t.value === currentTheme ? 'active' : ''}" data-theme-value="${t.value}">
                <span class="swatch-dot" style="background:${themeSwatchColor(t.value)};"></span>
                <span>${t.label}</span>
              </button>
            `).join('')}
          </div>
        </div>
      </div>

      <h2 class="settings-group-title">Preferences</h2>
      <div class="card mb-5">
        <div class="field">
          <label for="st-currency">Currency</label>
          <select class="select" id="st-currency" style="max-width:220px;">
            ${CURRENCIES.map((c) => `<option value="${c.code}" ${c.code === getCurrencyPreference() ? 'selected' : ''}>${c.symbol} ${c.label}</option>`).join('')}
          </select>
          <span class="field-hint">Changes how amounts are displayed. Doesn't convert existing amounts.</span>
        </div>
        <div class="field mb-0">
          <label for="st-default-account">Default account (pre-selected in forms)</label>
          <select class="select" id="st-default-account" style="max-width:280px;">
            <option value="">No default</option>
            ${accounts.map((a) => `<option value="${a.id}" ${a.id === defaultAccountId ? 'selected' : ''}>${a.name}</option>`).join('')}
          </select>
        </div>
      </div>

      <h2 class="settings-group-title">Notifications</h2>
      <div class="card mb-5">
        ${!isNotificationSupported() ? `
          <p class="text-sm text-muted mb-0">Your browser doesn't support notifications.</p>
        ` : `
          <label style="display:flex; align-items:center; gap: var(--sp-2); font-size: var(--fs-sm);" class="mb-1">
            <input type="checkbox" id="st-notifications" ${(await getNotificationsEnabled()) && getPermission() === 'granted' ? 'checked' : ''} /> Notify me about due bills, EMIs, and budgets
          </label>
          <p class="text-xs text-faint mb-0">Only while Finora is open in a tab — there's no background server, so nothing arrives when the app is fully closed.</p>
        `}
      </div>

      <h2 class="settings-group-title">Modules</h2>
      <div class="card mb-5">
        <p class="text-sm text-muted mb-3">Turn off what you don't use. Their data is kept — turning one back on brings its history right back.</p>
        <div class="flex-col">
          ${OPTIONAL_MODULES.map((m) => `
            <label style="display:flex; align-items:center; gap: var(--sp-2); font-size: var(--fs-sm);">
              <input type="checkbox" data-module="${m}" ${enabledModules[m] ? 'checked' : ''} /> ${MODULE_LABELS[m]}
            </label>
          `).join('')}
        </div>
      </div>

      <h2 class="settings-group-title">Data &amp; Privacy</h2>

      <div class="card mb-4">
        <h3 class="mb-1">Categories</h3>
        <p class="text-sm text-muted mb-3">Archived categories stay out of Income/Expense forms but past transactions keep their history.</p>
        <div id="st-categories"></div>
      </div>

      <div class="card mb-4">
        <h3 class="mb-1">Backup &amp; Restore</h3>
        <p class="text-sm text-muted mb-3">Your data lives only on this device. Back it up regularly — encrypted with a password only you know.</p>
        <div id="st-backup-reminder"></div>
        <div class="flex-row-wrap">
          <button class="btn btn-primary" id="btn-backup">${icons.archive} Create Backup</button>
          <button class="btn btn-secondary" id="btn-restore">Restore from Backup</button>
        </div>
      </div>

      <div class="card mb-4" id="st-google-backup-card">
        <h3 class="mb-1">Google Account Backup</h3>
        <p class="text-sm text-muted mb-3">Back this profile up to your Google Drive — private to your account, invisible in your normal Drive files.</p>
        <div id="st-google-backup-content">Loading…</div>
      </div>

      <div class="card mb-4">
        <h3 class="mb-1">Export</h3>
        <p class="text-sm text-muted mb-3">Plain CSV files for spreadsheets — not encrypted, not a substitute for backup.</p>
        <div class="flex-row-wrap">
          <button class="btn btn-secondary btn-sm" id="btn-export-txn">All Transactions</button>
          <button class="btn btn-secondary btn-sm" id="btn-export-income">Income Only</button>
          <button class="btn btn-secondary btn-sm" id="btn-export-expenses">Expenses Only</button>
        </div>
      </div>

      <div class="card mb-4">
        <h3 class="mb-1">Bulk Import</h3>
        <p class="text-sm text-muted mb-3">Bring in income/expense transactions from a spreadsheet. Columns: Date, Type, Amount, Category, Account, Description.</p>
        <button class="btn btn-secondary" id="btn-bulk-import">${icons.plus || ''} Import CSV</button>
      </div>

      <div class="card">
        <h3 style="margin-bottom: var(--sp-1); color: var(--color-danger);">Delete All Data</h3>
        <p class="text-sm text-muted mb-3">Permanently erases every account, transaction, and record in Finora on this device. This cannot be undone — back up first if you're not sure.</p>
        <button class="btn btn-danger" id="btn-delete-all">${icons.trash} Delete All Data</button>
      </div>
    </div>
  `;

  qs('#st-currency', root).addEventListener('change', async (e) => {
    setCurrencyPreference(e.target.value);
    toast.success('Currency updated.');
    await renderSettingsPage(root);
  });

  root.querySelectorAll('[data-theme-value]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setTheme(btn.dataset.themeValue);
      root.querySelectorAll('#st-theme-swatches .swatch-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      toast.success('Theme updated.');
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

  const notifCheckbox = qs('#st-notifications', root);
  if (notifCheckbox) {
    notifCheckbox.addEventListener('change', async (e) => {
      if (e.target.checked) {
        const permission = await requestPermission();
        if (permission !== 'granted') {
          e.target.checked = false;
          toast.error('Notifications were blocked. Enable them in your browser settings to use this.');
          return;
        }
        await setNotificationsEnabled(true);
        toast.success('Notifications enabled.');
      } else {
        await setNotificationsEnabled(false);
        toast.success('Notifications disabled.');
      }
    });
  }

  qs('#btn-backup', root).addEventListener('click', openBackupModal);
  qs('#btn-restore', root).addEventListener('click', openRestoreModal);
  qs('#btn-export-txn', root).addEventListener('click', () => exportCsv('transactions').then(() => toast.success('Exported.')));
  qs('#btn-export-income', root).addEventListener('click', () => exportCsv('income').then(() => toast.success('Exported.')));
  qs('#btn-export-expenses', root).addEventListener('click', () => exportCsv('expenses').then(() => toast.success('Exported.')));
  qs('#btn-delete-all', root).addEventListener('click', openDeleteAllModal);

  qs('#btn-add-profile', root)?.addEventListener('click', () => openAddProfileModal(root));

  root.querySelectorAll('[data-switch-profile]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Switch profile?',
        message: 'Finora will reload into that profile\'s data.',
        confirmLabel: 'Switch',
      });
      if (!ok) return;
      switchProfile(btn.dataset.switchProfile);
      location.reload();
    });
  });

  root.querySelectorAll('[data-rename-profile]').forEach((btn) => {
    btn.addEventListener('click', () => openRenameProfileModal(btn.dataset.renameProfile, profiles, root));
  });

  root.querySelectorAll('[data-delete-profile]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const profile = profiles.find((p) => p.id === btn.dataset.deleteProfile);
      const ok = await confirmDialog({
        title: `Delete "${profile?.name}"?`,
        message: 'This permanently deletes that profile and every account/transaction in it. This cannot be undone.',
        danger: true,
        confirmLabel: 'Delete Profile',
      });
      if (!ok) return;
      try {
        await deleteProfile(btn.dataset.deleteProfile);
        toast.success('Profile deleted.');
        await renderSettingsPage(root);
      } catch (err) {
        toast.error(err.message || 'Something went wrong.');
      }
    });
  });
  qs('#btn-bulk-import', root).addEventListener('click', openBulkImportModal);

  await renderCategories(root);
  await renderBackupReminder();
  await renderGoogleBackupCard(root);
}

async function renderGoogleBackupCard(root) {
  const contentEl = document.querySelector('#st-google-backup-content');
  if (!contentEl) return;

  if (!isGoogleConfigured()) {
    contentEl.innerHTML = `<p class="text-sm text-faint">Not available in this deployment yet.</p>`;
    return;
  }

  if (!isGoogleConnected()) {
    contentEl.innerHTML = `<button class="btn btn-secondary" id="btn-google-connect">${icons.archive || ''} Connect Google Account</button>`;
    document.querySelector('#btn-google-connect')?.addEventListener('click', async () => {
      try {
        const email = await connectGoogleAccount();
        toast.success(`Connected as ${email}.`);
        await renderGoogleBackupCard(root);
      } catch (err) {
        toast.error(err.message || 'Could not connect to Google.');
      }
    });
    return;
  }

  if (!getAccessToken()) {
    contentEl.innerHTML = `<p class="text-sm text-muted">Reconnecting…</p>`;
    const ok = await trySilentReconnect();
    if (!ok) {
      contentEl.innerHTML = `
        <p class="text-sm text-muted mb-2">Your Google session needs to be refreshed.</p>
        <button class="btn btn-secondary" id="btn-google-connect">${icons.archive || ''} Reconnect Google Account</button>
      `;
      document.querySelector('#btn-google-connect')?.addEventListener('click', async () => {
        try {
          const email = await connectGoogleAccount();
          toast.success(`Connected as ${email}.`);
          await renderGoogleBackupCard(root);
        } catch (err) {
          toast.error(err.message || 'Could not connect to Google.');
        }
      });
      return;
    }
  }

  // Connected — show account, last backup info, and actions.
  let lastBackupText = 'Checking…';
  contentEl.innerHTML = `
    <p class="text-sm mb-2">Connected as <strong>${escapeHtml(getConnectedEmail() || '')}</strong></p>
    <p class="text-sm text-muted mb-3" id="st-google-last-backup">${lastBackupText}</p>
    <div class="flex-row-wrap mb-2">
      <button class="btn btn-primary btn-sm" id="btn-google-backup-now">Backup Now</button>
      <button class="btn btn-secondary btn-sm" id="btn-google-restore">Restore</button>
      <button class="btn btn-ghost btn-sm" id="btn-google-disconnect" style="color:var(--color-danger);">Disconnect</button>
    </div>
  `;

  getGoogleDriveBackupInfo()
    .then((info) => {
      const el = document.querySelector('#st-google-last-backup');
      if (!el) return;
      el.textContent = info ? `Last backup: ${formatDate(info.modifiedTime)}` : 'No backup yet.';
    })
    .catch(() => {
      const el = document.querySelector('#st-google-last-backup');
      if (el) el.textContent = 'Could not check for an existing backup.';
    });

  document.querySelector('#btn-google-backup-now')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await backupToGoogleDrive();
      toast.success('Backed up to Google Drive.');
      await renderGoogleBackupCard(root);
    } catch (err) {
      toast.error(err.message || 'Backup failed.');
      e.target.disabled = false;
    }
  });

  document.querySelector('#btn-google-restore')?.addEventListener('click', () => openGoogleRestoreModal(root));

  document.querySelector('#btn-google-disconnect')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Disconnect Google Account?', message: 'You can reconnect anytime. Your Drive backup stays where it is.' });
    if (!ok) return;
    disconnectGoogleAccount();
    toast.success('Disconnected.');
    await renderGoogleBackupCard(root);
  });
}

function openGoogleRestoreModal(settingsRoot) {
  openModal({
    title: 'Restore from Google Drive',
    bodyHtml: `
      <p class="text-sm mb-3">This downloads your Google Drive backup for this profile and merges it into what's here. Your current local data is <strong>not deleted first</strong> — nothing is overwritten silently.</p>
      <div class="field mb-0">
        <label for="gr-mode">Mode</label>
        <select class="select" id="gr-mode">
          <option value="merge">Merge — keep existing data, add anything new</option>
          <option value="replace">Replace — clear this profile's data, then restore</option>
        </select>
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      { label: 'Restore', variant: 'btn-danger', onClick: async (close, modalRoot) => {
          const mode = qs('#gr-mode', modalRoot).value;
          if (mode === 'replace') {
            const ok = await confirmDialog({ title: 'Replace all data?', message: 'This clears everything in this profile before restoring from Google Drive. This cannot be undone.', danger: true, confirmLabel: 'Replace Everything' });
            if (!ok) return;
          }
          try {
            await restoreFromGoogleDrive(mode);
            close();
            toast.success('Restored from Google Drive. Reloading…');
            setTimeout(() => location.reload(), 1200);
          } catch (err) {
            toast.error(err.message || 'Could not restore this backup.');
          }
        } },
    ],
  });
}

async function renderBackupReminder() {
  const status = await getBackupReminderStatus();
  const el = document.querySelector('#st-backup-reminder');
  if (!el) return;
  if (!status) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="badge badge-warning mb-3" style="display:inline-flex; align-items:center; gap: var(--sp-2);">
      ${status.message} Consider backing up now.
    </div>
  `;
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
    <div class="list mb-3">${income.map(row).join('')}</div>
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
      <p class="text-sm mb-3">Choose a password. You'll need it to restore this backup later — Finora cannot recover it for you.</p>
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
            await recordBackupCompleted();
            close();
            toast.success('Backup downloaded.');
            renderBackupReminder();
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
      <div class="field mb-0">
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

function openBulkImportModal() {
  openModal({
    title: 'Bulk Import CSV',
    size: 'lg',
    bodyHtml: `
      <div class="field">
        <label for="bi-file">CSV file</label>
        <input class="input" id="bi-file" type="file" accept=".csv,text/csv" />
        <span class="field-hint">Columns: Date, Type (income/expense), Amount, Category, Account, Description.</span>
      </div>
      <div id="bi-preview"></div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      { label: 'Import Valid Rows', variant: 'btn-primary', onClick: async (close, modalRoot) => {
          const validated = modalRoot._biValidated;
          if (!validated) return;
          const result = await importValidRows(validated);
          close();
          toast.success(`Imported ${result.imported} transaction${result.imported === 1 ? '' : 's'}.${result.failed ? ` ${result.failed} failed unexpectedly.` : ''}`);
        } },
    ],
    onMount: (root) => {
      qs('#bi-file', root).addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const text = await file.text();
        const rows = parseCsv(text);
        if (rows.length === 0) {
          qs('#bi-preview', root).innerHTML = `<p class="text-sm text-muted mt-3">No rows found in this file.</p>`;
          return;
        }
        const validated = await validateImportRows(rows);
        root._biValidated = validated;
        const validCount = validated.filter((v) => v.valid).length;
        const errorCount = validated.length - validCount;

        qs('#bi-preview', root).innerHTML = `
          <p class="text-sm mt-3 mb-2"><strong>${validCount}</strong> row${validCount === 1 ? '' : 's'} ready to import${errorCount ? `, <strong style="color:var(--color-danger);">${errorCount}</strong> with errors` : ''}.</p>
          <div class="list" style="max-height:260px; overflow-y:auto;">
            ${validated.map((v) => `
              <div class="list-row">
                <div class="row-main">
                  <div class="row-title">${v.valid ? `${escapeHtml(v.raw.description || v.category)}` : `Row ${v.rowNum}`}</div>
                  <div class="row-sub" style="${v.valid ? '' : 'color:var(--color-danger);'}">${v.valid ? `${v.type} · ${v.category} · ${v.raw.account}` : v.error}</div>
                </div>
                ${v.valid ? `<span class="amount num">${formatCurrency(v.amount)}</span>` : `<span class="badge badge-danger">Error</span>`}
              </div>
            `).join('')}
          </div>
        `;
      });
    },
  });
}

const PROFILE_EMOJIS = ['👤', '👨', '👩', '👧', '👦', '🧑', '👴', '👵'];

function openAddProfileModal(settingsRoot) {
  let selectedEmoji = PROFILE_EMOJIS[0];
  openModal({
    title: 'Add Profile',
    bodyHtml: `
      <div class="field">
        <label for="ap-name">Name</label>
        <input class="input" id="ap-name" type="text" placeholder="e.g. Mom" autofocus />
      </div>
      <div class="field mb-0">
        <label>Icon</label>
        <div class="flex-row-wrap" id="ap-emoji-picker">
          ${PROFILE_EMOJIS.map((e) => `<button type="button" class="btn btn-secondary btn-sm" data-emoji="${e}" style="font-size:16px;">${e}</button>`).join('')}
        </div>
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      { label: 'Add Profile', variant: 'btn-primary', onClick: async (close, modalRoot) => {
          const name = qs('#ap-name', modalRoot).value.trim();
          try {
            const profile = createProfile({ name, emoji: selectedEmoji });
            close();
            toast.success(`"${profile.name}" added. Switch to it from Settings when ready.`);
            await renderSettingsPage(settingsRoot);
          } catch (err) {
            toast.error(err.message || 'Something went wrong.');
          }
        } },
    ],
    onMount: (modalRoot) => {
      modalRoot.querySelectorAll('[data-emoji]').forEach((btn) => {
        btn.addEventListener('click', () => {
          selectedEmoji = btn.dataset.emoji;
          modalRoot.querySelectorAll('[data-emoji]').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });
    },
  });
}

function openRenameProfileModal(id, profiles, settingsRoot) {
  const profile = profiles.find((p) => p.id === id);
  if (!profile) return;
  openModal({
    title: `Rename "${profile.name}"`,
    bodyHtml: `
      <div class="field mb-0">
        <label for="rp-name">Name</label>
        <input class="input" id="rp-name" type="text" value="${escapeHtml(profile.name)}" autofocus />
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      { label: 'Save', variant: 'btn-primary', onClick: async (close, modalRoot) => {
          try {
            renameProfile(id, qs('#rp-name', modalRoot).value);
            close();
            toast.success('Renamed.');
            await renderSettingsPage(settingsRoot);
          } catch (err) {
            toast.error(err.message || 'Something went wrong.');
          }
        } },
    ],
  });
}

function openDeleteAllModal() {
  openModal({
    title: 'Delete All Data',
    bodyHtml: `
      <p class="text-sm mb-3">This permanently erases every account, transaction, committee, loan, goal, and person in Finora on this device. <strong>This cannot be undone.</strong></p>
      <div class="field mb-0">
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
