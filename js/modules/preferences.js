// ==========================================================================
// Finora — modules/preferences.js
// ==========================================================================

import { withTransaction, reqToPromise } from '../core/db.js';

export const OPTIONAL_MODULES = ['income', 'expenses', 'budgets', 'scheduled', 'people', 'billsplits', 'loans', 'bidsave', 'savings', 'investments', 'recurring'];

export async function getSetting(key, fallback = null) {
  return withTransaction(['settings'], 'readonly', async (tx) => {
    const rec = await reqToPromise(tx.objectStore('settings').get(key));
    return rec?.value ?? fallback;
  });
}

// Bookkeeping keys: changing them is NOT a change to the user's data, so it must not trigger an auto-backup.
const QUIET_SETTING_KEYS = new Set(['lastBackupAt', 'notifiedLog', 'cloudSync', 'cloudDirty', 'cloudStartFresh', 'e2eKey', 'serverSyncEnabled', 'autoSync', 'datasetId', 'deviceId']);

export async function setSetting(key, value) {
  return withTransaction(['settings'], 'readwrite', (tx) => {
    tx.objectStore('settings').put({ key, value });
  }, { quiet: QUIET_SETTING_KEYS.has(key) });
}

/** All optional modules default to OFF until the user turns one on from Settings. */
export async function getEnabledModules() {
  const stored = await getSetting('enabledModules', null);
  const defaults = Object.fromEntries(OPTIONAL_MODULES.map((m) => [m, false]));
  return { ...defaults, ...(stored || {}) };
}

export async function setModuleEnabled(moduleKey, enabled) {
  const current = await getEnabledModules();
  current[moduleKey] = enabled;
  await setSetting('enabledModules', current);
  return current;
}

export async function isOnboardingComplete() {
  return getSetting('onboardingComplete', false);
}

export async function markOnboardingComplete() {
  return setSetting('onboardingComplete', true);
}

/** Named search+type filter combinations saved from the Transactions page. */
export async function getSavedFilters() {
  return getSetting('savedTxnFilters', []);
}

export async function saveFilter({ name, searchTerm, typeFilter }) {
  const filters = await getSavedFilters();
  const entry = { id: `flt_${Date.now().toString(36)}`, name, searchTerm, typeFilter };
  filters.push(entry);
  await setSetting('savedTxnFilters', filters);
  return entry;
}

export async function deleteSavedFilter(id) {
  const filters = await getSavedFilters();
  await setSetting('savedTxnFilters', filters.filter((f) => f.id !== id));
}
