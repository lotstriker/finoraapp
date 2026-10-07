// ==========================================================================
// Finora — pages/cloud-sync-ui.js
// Everything the user SEES for automatic cloud sync: the topbar status chip, the
// "cloud is newer" / "choose a backup" dialogs and the Restore picker.
// (Logic lives in modules/cloud-sync.js — this file has no sync rules of its own.)
// ==========================================================================

import { openModal, confirmDialog } from '../core/modal.js';
import { toast } from '../core/toast.js';
import { formatDate, escapeHtml, qs } from '../utils/dom.js';
import {
  getSyncStatus, onSyncStatus, requestSync, refreshCloudSync, markSynced, chooseStartFreshBackup,
} from '../modules/cloud-sync.js';
import { backupToGoogleDrive, restoreFromGoogleDrive, listCloudBackups } from '../modules/google-drive-backup.js';
import { connectGoogleAccount } from '../modules/google-auth.js';
import { getServerSyncStatus, onServerSyncStatus, runServerSync } from '../modules/server-sync.js';
import { signInWithGoogle } from '../modules/supabase-client.js';

/** "just now" / "5 min ago" / "3 h ago" / a date. */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return '';
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return formatDate(iso);
}

/** Label shown in the chip. Always TEXT (colour is only a hint), so it works for everyone. */
const CHIP_LABEL = {
  idle: 'Synced', pending: 'Saving soon', syncing: 'Syncing…', offline: 'Offline',
  'needs-reconnect': 'Reconnect', conflict: 'Conflict', 'update-available': 'Update ready',
  'choose-backup': 'Choose backup', error: 'Sync issue',
};

/** Chip labels for LIVE server sync (Supabase). */
const SERVER_CHIP_LABEL = {
  idle: 'Live', pending: 'Saving…', syncing: 'Syncing…', offline: 'Offline',
  'needs-signin': 'Sign in', 'needs-unlock': 'Unlock', error: 'Sync issue',
};

/** One-line explanation for server sync (tooltip + Settings card). */
export function serverStatusText(s) {
  switch (s.state) {
    case 'off': return 'Live sync is off on this device.';
    case 'idle': return `${s.realtime ? 'Live — changes from your other devices appear within a second or two.' : 'Synced (checking for changes every minute).'}${s.lastSyncedAt ? ` Last synced ${relativeTime(s.lastSyncedAt)}.` : ''}`;
    case 'pending': return 'Your changes will be sent in a moment.';
    case 'syncing': return 'Syncing…';
    case 'offline': return s.message || 'Offline — Finora will sync when it can reach the server.';
    case 'needs-signin': return `${s.message || 'Sign in again to keep syncing.'} Tap to sign in.`;
    case 'needs-unlock': return `${s.message || 'Enter your encryption passphrase.'} Tap to open Settings.`;
    case 'error': return s.message || 'Sync failed.';
    default: return '';
  }
}

/** Which sync is the user actually relying on? Live server sync wins over Drive auto-backup. */
function activeSource() {
  const server = getServerSyncStatus();
  return server.state !== 'off' ? { kind: 'server', s: server } : { kind: 'drive', s: getSyncStatus() };
}

/** One-line explanation (tooltip + Settings card). */
export function statusText(s) {
  switch (s.state) {
    case 'off': return 'Automatic sync is off.';
    case 'idle': return s.lastSyncedAt ? `All changes saved to Google Drive (${relativeTime(s.lastSyncedAt)}).` : 'Up to date with Google Drive.';
    case 'pending': return 'Changes will be saved to Google Drive in a few seconds.';
    case 'syncing': return 'Syncing with Google Drive…';
    case 'offline': return 'You are offline — Finora will sync when you are back online.';
    case 'needs-reconnect': return `${s.message || 'Google needs you to sign in again.'} Tap to reconnect.`;
    case 'conflict': return 'Another device saved newer data and this device also has unsaved changes. Tap to choose what to do.';
    case 'update-available': return 'Newer data from another device is ready. It will be applied as soon as you close the open dialog.';
    case 'choose-backup': return 'Backups from another device or profile were found. Tap to restore one or start a separate backup.';
    case 'error': return `${s.message || 'Sync failed.'}${s.retryAt ? ' Finora will retry automatically.' : ''}`;
    default: return '';
  }
}

/* ---------------------------------------------------------------------- */
/* Topbar chip                                                            */
/* ---------------------------------------------------------------------- */

function renderChip(chip) {
  const { kind, s } = activeSource();
  if (s.state === 'off') { chip.hidden = true; return; }
  const labels = kind === 'server' ? SERVER_CHIP_LABEL : CHIP_LABEL;
  const text = kind === 'server' ? serverStatusText(s) : statusText(s);
  chip.hidden = false;
  chip.dataset.state = s.state === 'needs-signin' || s.state === 'needs-unlock' ? 'needs-reconnect' : s.state;   // reuse the chip colours
  chip.dataset.source = kind;
  chip.querySelector('.sync-chip-label').textContent = labels[s.state] || '';
  chip.title = text;
  chip.setAttribute('aria-label', `${kind === 'server' ? 'Live sync' : 'Cloud sync'}: ${labels[s.state] || ''}. ${text}`);
}

async function onChipClick() {
  const active = activeSource();
  if (active.kind === 'server') {
    try {
      if (active.s.state === 'needs-signin') await signInWithGoogle();
      else if (active.s.state === 'needs-unlock') location.hash = '#/settings';
      else await runServerSync({ reason: 'chip' });
    } catch (err) { toast.error(err.message || 'Could not sync.'); }
    return;
  }
  const s = active.s;
  try {
    switch (s.state) {
      case 'needs-reconnect': {
        // A click is the user gesture Google's token model requires for a new token.
        await connectGoogleAccount({ prompt: '' });
        await refreshCloudSync();
        await requestSync('reconnected', { interactive: true });
        toast.success('Reconnected to Google.');
        break;
      }
      case 'conflict': openCloudConflictModal({ message: s.message, remoteModifiedTime: s.remote?.modifiedTime }); break;
      case 'choose-backup': openChooseBackupModal(s.backups || []); break;
      default: await requestSync('chip', { interactive: true });          // idle/pending/error/offline/update: "sync now"
    }
  } catch (err) {
    toast.error(err.message || 'Could not sync.');
  }
}

/** Wires the chip that app.js put in the topbar. Returns an unsubscribe function. */
export function initCloudSyncUI() {
  const chip = document.querySelector('#sync-chip');
  if (!chip) return () => {};
  chip.addEventListener('click', onChipClick);
  renderChip(chip);
  const off = [onSyncStatus(() => renderChip(chip)), onServerSyncStatus(() => renderChip(chip))];
  return () => off.forEach((fn) => fn());
}

/* ---------------------------------------------------------------------- */
/* Dialogs                                                                */
/* ---------------------------------------------------------------------- */

const backupLabel = (b) => `${b.type === 'legacy' ? 'Older-format backup' : (b.profileName || 'Unnamed profile')} · ${formatDate(b.modifiedTime)}`;

/** Another device saved since this one last synced AND this device has unsaved changes: never overwrite silently. */
export function openCloudConflictModal(err, onDone = () => {}) {
  const when = err.remoteModifiedTime ? formatDate(err.remoteModifiedTime) : 'recently';
  openModal({
    title: 'Cloud backup is newer',
    bodyHtml: `
      <p class="text-sm mb-3">${escapeHtml(err.message || 'The cloud backup was changed by another device.')} (cloud copy saved ${escapeHtml(when)}).</p>
      <p class="text-sm mb-0"><strong>Merge first</strong> adds the cloud's data to this device (nothing here is deleted), then saves the combined result.
      <strong>Overwrite cloud</strong> replaces the cloud copy with what is on this device — anything only the cloud has will be lost.</p>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      { label: 'Overwrite cloud', variant: 'btn-danger', onClick: async (close) => {
          const ok = await confirmDialog({ title: 'Overwrite the cloud backup?', message: 'The cloud copy will be replaced by this device\'s data. This cannot be undone.', danger: true, confirmLabel: 'Overwrite' });
          if (!ok) return;
          try {
            await backupToGoogleDrive({ force: true });
            await markSynced();
            close();
            toast.success('Cloud backup overwritten.');
            await requestSync('resolved');
            onDone();
          } catch (e) { toast.error(e.message || 'Backup failed.'); }
        } },
      { label: 'Merge first', variant: 'btn-primary', onClick: async (close) => {
          try {
            await restoreFromGoogleDrive('merge');            // this profile's own cloud file
            await backupToGoogleDrive();                       // then save the combined result
            await markSynced();
            close();
            toast.success('Merged the cloud copy and saved. Reloading…');
            setTimeout(() => location.reload(), 1200);
          } catch (e) { toast.error(e.message || 'Could not merge.'); }
        } },
    ],
  });
}

/** Restore picker (several backups can exist: other devices, other profiles, older formats). */
export async function openGoogleRestoreModal({ backups, title = 'Restore from Google Drive' } = {}) {
  let list = backups;
  if (!list) {
    try { list = await listCloudBackups(); }
    catch (e) { toast.error(e.message || 'Could not reach Google Drive.'); return; }
  }
  if (list.length === 0) { toast.info('No Google Drive backup found for this account.'); return; }
  openModal({
    title,
    bodyHtml: `
      <div class="field">
        <label for="gr-file">Backup</label>
        <select class="select" id="gr-file">${list.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(backupLabel(b))}</option>`).join('')}</select>
      </div>
      <p class="text-sm mb-3">Merge keeps what is already here and adds anything new; nothing is deleted first.</p>
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
            await restoreFromGoogleDrive(mode, { fileId: qs('#gr-file', modalRoot).value });
            await markSynced();                                // restore recorded the sync point; nothing is unsaved
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

/** Backups exist, but none belongs to THIS profile: restore one, or deliberately start a separate backup. */
export function openChooseBackupModal(backups) {
  openModal({
    title: 'Backups found in your Google account',
    bodyHtml: `
      <p class="text-sm mb-3">We found ${backups.length} Finora backup${backups.length === 1 ? '' : 's'} (for example from your other device), but none for this profile yet.</p>
      <p class="text-sm mb-0"><strong>Restore</strong> loads one of them here, and this device then keeps in sync with it automatically.
      <strong>Start separate backup</strong> keeps this profile's data apart from those backups.</p>
    `,
    actions: [
      { label: 'Not now', variant: 'btn-secondary', onClick: (close) => close() },
      { label: 'Start separate backup', variant: 'btn-secondary', onClick: async (close) => {
          close();
          try { await chooseStartFreshBackup(); toast.success('Backing up this profile separately.'); }
          catch (e) { toast.error(e.message || 'Could not start the backup.'); }
        } },
      { label: 'Restore one…', variant: 'btn-primary', onClick: (close) => { close(); openGoogleRestoreModal({ backups, title: 'Restore a backup' }); } },
    ],
  });
}
