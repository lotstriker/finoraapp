// ==========================================================================
// Finora — pages/server-sync-ui.js
// The "Server sync (beta)" card in Settings: Step 1 sign in, Step 2 passphrase, Step 3 ready.
// (The sync engine itself is the next step; this card lets you set up and verify the account + encryption.)
// ==========================================================================

import { toast } from '../core/toast.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { escapeHtml, qs, formatDate } from '../utils/dom.js';
import {
  isServerSyncEnabled, enableServerSync, disableServerSync, listServerDatasets, runServerSync,
  getServerSyncStatus, onServerSyncStatus, resetConflictCounter,
} from '../modules/server-sync.js';
import { setAutoSyncEnabled } from '../modules/cloud-sync.js';
import { getConflictLog, clearConflictLog } from '../modules/sync-engine.js';
import { getDatasetId } from '../modules/backup.js';
import { serverStatusText } from './cloud-sync-ui.js';
import { validateSupabaseConfig, signInWithGoogle, signOut } from '../modules/supabase-client.js';
import { getSetupState, setUpEncryption, unlockWithPassphrase, lockThisDevice } from '../modules/server-account.js';
import { assessPassphrase, MIN_PASSPHRASE_LENGTH } from '../modules/e2e-crypto.js';

const html = (strings, ...v) => strings.reduce((a, s, i) => a + s + (v[i] ?? ''), '');

export async function renderServerSyncCard(host) {
  const config = validateSupabaseConfig();
  if (!config.ok) {
    host.innerHTML = html`<p class="text-sm text-muted mb-0">${escapeHtml(config.problem)} See <code>supabase/SETUP.md</code>.</p>`;
    return;
  }

  let setup;
  try { setup = await getSetupState(); }
  catch (e) {
    host.innerHTML = html`<p class="text-sm mb-2" style="color:var(--color-danger);">${escapeHtml(e.message)}</p>
      <p class="text-sm text-muted mb-0">If your Supabase project was inactive for a week it may be <strong>paused</strong> (free plan) — open the Supabase dashboard and restore it. Finora keeps working offline meanwhile.</p>`;
    return;
  }

  if (setup.state === 'signed-out') {
    host.innerHTML = html`
      <p class="text-sm mb-3"><strong>Step 1 of 2.</strong> Sign in so your devices can share one encrypted copy of your data.</p>
      <button class="btn btn-primary btn-sm" id="ss-signin">Sign in with Google</button>`;
    qs('#ss-signin', host).addEventListener('click', async (e) => {
      const btn = e.currentTarget;                         // capture now: currentTarget is null after the first await
      btn.disabled = true;
      try { await signInWithGoogle(); } catch (err) { toast.error(err.message); btn.disabled = false; }
    });
    return;
  }

  const who = escapeHtml(setup.user?.email || 'your account');

  if (setup.state === 'needs-create') {
    host.innerHTML = html`
      <p class="text-sm mb-2">Signed in as <strong>${who}</strong>. <strong>Step 2 of 2 — choose an encryption passphrase.</strong></p>
      <p class="text-sm text-muted mb-3">Your data is encrypted on this device with this passphrase <em>before</em> it is sent, so the server can never read it. Use ${MIN_PASSPHRASE_LENGTH}+ characters — 4–5 random words works well.</p>
      <div class="field"><label for="ss-pass">Passphrase</label><input class="input" id="ss-pass" type="password" autocomplete="new-password" /></div>
      <div class="field"><label for="ss-pass2">Repeat passphrase</label><input class="input" id="ss-pass2" type="password" autocomplete="new-password" /></div>
      <label class="sync-toggle mb-3"><input type="checkbox" id="ss-ack" /> <span>I understand that if I forget this passphrase, the data stored on the server <strong>cannot be recovered</strong> (my data on my devices and my backups are not affected).</span></label>
      <div class="flex-row-wrap"><button class="btn btn-primary btn-sm" id="ss-create">Save passphrase</button><button class="btn btn-secondary btn-sm" id="ss-signout">Sign out</button></div>`;
    qs('#ss-create', host).addEventListener('click', async (e) => {
      const pass = qs('#ss-pass', host).value;
      const problem = assessPassphrase(pass);
      if (!problem.ok) return toast.error(problem.problem);
      if (pass !== qs('#ss-pass2', host).value) return toast.error('The two passphrases do not match.');
      if (!qs('#ss-ack', host).checked) return toast.error('Please tick the box to confirm you understand.');
      const btn = e.currentTarget;
      btn.disabled = true;
      try { await setUpEncryption(pass); toast.success('Encryption is set up on this device.'); await renderServerSyncCard(host); }
      catch (err) { toast.error(err.message); btn.disabled = false; }
    });
  } else if (setup.state === 'needs-unlock') {
    host.innerHTML = html`
      <p class="text-sm mb-2">Signed in as <strong>${who}</strong>. <strong>Enter your encryption passphrase</strong> to use synced data on this device.</p>
      <div class="field"><label for="ss-pass">Passphrase</label><input class="input" id="ss-pass" type="password" autocomplete="current-password" /></div>
      <div class="flex-row-wrap"><button class="btn btn-primary btn-sm" id="ss-unlock">Unlock</button><button class="btn btn-secondary btn-sm" id="ss-signout">Sign out</button></div>`;
    qs('#ss-unlock', host).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try { await unlockWithPassphrase(qs('#ss-pass', host).value); toast.success('Unlocked.'); await renderServerSyncCard(host); }
      catch (err) { toast.error(err.message); btn.disabled = false; }
    });
  } else {
    await renderReady(host, who);
    return;
  }
  host.querySelector('#ss-signout')?.addEventListener('click', async () => {
    try { await lockThisDevice(); await signOut(); await renderServerSyncCard(host); } catch (err) { toast.error(err.message); }
  });
}

let statusUnsub = null;

/** Encryption is ready on this device: turn live sync on/off, join a dataset, see conflicts. */
async function renderReady(host, who) {
  const enabled = await isServerSyncEnabled();

  if (!enabled) {
    let datasets = [];
    try { datasets = await listServerDatasets(); } catch (e) { toast.error(e.message); }
    const mine = await getDatasetId();
    const options = datasets.map((d, i) => `<option value="${escapeHtml(d.dataset_id)}" ${i === 0 ? 'selected' : ''}>Join existing data — ${d.record_count} records, last changed ${escapeHtml(formatDate(d.updated_at))}${d.dataset_id === mine ? ' (this device\'s own)' : ''}</option>`);
    options.push(`<option value="" ${datasets.length ? '' : 'selected'}>${datasets.length ? 'Start a separate set from this device' : 'Start syncing this device\'s data'}</option>`);
    host.innerHTML = html`
      <p class="text-sm mb-2">Signed in as <strong>${who}</strong> · encryption is <strong>ready on this device</strong>.</p>
      <div class="field"><label for="ss-dataset">What should this device sync with?</label>
        <select class="select" id="ss-dataset">${options.join('')}</select></div>
      <p class="text-xs text-faint mb-3">The first sync <strong>merges</strong>: data from the server is added here, and anything only this device has is sent up. If both devices already set up the same account separately you may see it twice — archive the extra one.
      Starting live sync turns off the Google Drive auto-backup (two syncs on the same data would only confuse each other); manual backups still work.</p>
      <div class="flex-row-wrap"><button class="btn btn-primary btn-sm" id="ss-start">Start live sync</button>
      <button class="btn btn-secondary btn-sm" id="ss-lock">Lock this device</button><button class="btn btn-secondary btn-sm" id="ss-signout">Sign out</button></div>`;
    qs('#ss-start', host).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const joinDatasetId = qs('#ss-dataset', host).value || undefined;
      const ok = await confirmDialog({ title: 'Start live sync?', message: 'This device will merge with the server now and then stay in sync. Your data is encrypted before it leaves this device.', confirmLabel: 'Start' });
      if (!ok) return;
      btn.disabled = true;
      try {
        await setAutoSyncEnabled(false);
        const st = await enableServerSync({ joinDatasetId });
        if (st.state === 'idle') toast.success('Live sync is on.');
        else if (st.message) toast.error(st.message);
        await renderServerSyncCard(host);
      } catch (err) { toast.error(err.message); btn.disabled = false; }
    });
    qs('#ss-lock', host).addEventListener('click', async () => { await lockThisDevice(); toast.success('This device is locked.'); await renderServerSyncCard(host); });
  } else {
    const log = await getConflictLog();
    host.innerHTML = html`
      <p class="text-sm mb-1">Signed in as <strong>${who}</strong> · live sync is <strong>on</strong>.</p>
      <p class="text-sm mb-2" id="ss-status" aria-live="polite"></p>
      ${log.length ? html`<p class="text-sm mb-2" style="color:var(--color-warning);">${log.length} of your edits were replaced by newer versions from another device. Your copies are kept. <button class="btn btn-secondary btn-sm" id="ss-conflicts">View</button></p>` : ''}
      <p class="text-xs text-faint mb-3">Changes are encrypted on this device, sent a moment after you make them, and other devices pick them up within a second or two while they are open. If you stop using Finora for a week, a free Supabase project pauses itself; open the Supabase dashboard and restore it — nothing is lost.</p>
      <div class="flex-row-wrap"><button class="btn btn-secondary btn-sm" id="ss-syncnow">Sync now</button>
      <button class="btn btn-secondary btn-sm" id="ss-stop">Stop syncing on this device</button><button class="btn btn-secondary btn-sm" id="ss-signout">Sign out</button></div>`;
    const paint = (st) => { const el = host.querySelector('#ss-status'); if (el) el.textContent = serverStatusText(st); };
    paint(getServerSyncStatus());
    statusUnsub?.(); statusUnsub = onServerSyncStatus(paint);
    qs('#ss-syncnow', host).addEventListener('click', async () => { const st = await runServerSync({ reason: 'manual' }); if (st.state === 'idle') toast.success('Up to date.'); });
    qs('#ss-stop', host).addEventListener('click', async () => { await disableServerSync(); toast.success('Live sync is off on this device. Server data is untouched.'); await renderServerSyncCard(host); });
    host.querySelector('#ss-conflicts')?.addEventListener('click', () => openConflictLog(host));
  }
  host.querySelector('#ss-signout')?.addEventListener('click', async () => {
    try { await disableServerSync(); await lockThisDevice(); await signOut(); await renderServerSyncCard(host); } catch (err) { toast.error(err.message); }
  });
}

/** The edits that a newer version from another device replaced — kept so nothing is silently lost. */
function openConflictLog(host) {
  getConflictLog().then((log) => {
    const label = (c) => c.kind === 'remote-deleted' ? 'deleted on another device' : c.kind === 'local-deleted' ? 'you deleted it, but it was changed elsewhere' : 'edited on another device';
    const name = (c) => escapeHtml(c.local?.name || c.local?.description || c.local?.category || c.id);
    openModal({
      title: 'Edits that were replaced',
      bodyHtml: `<p class="text-sm mb-3">When the same item changes on two devices, the newer version from the server wins. Your version is listed here so you can re-enter it if you still need it.</p>
        <div class="list">${log.map((c) => `<div class="list-row"><div><div class="row-title">${escapeHtml(c.store)} · ${name(c)}</div><div class="text-xs text-faint">${escapeHtml(label(c))} · ${escapeHtml(formatDate(c.at))}</div></div></div>`).join('') || '<p class="text-sm">Nothing here.</p>'}</div>`,
      actions: [
        { label: 'Clear list', variant: 'btn-secondary', onClick: async (close) => { await clearConflictLog(); resetConflictCounter(); close(); await renderServerSyncCard(host); } },
        { label: 'Close', variant: 'btn-primary', onClick: (close) => close() },
      ],
    });
  });
}
