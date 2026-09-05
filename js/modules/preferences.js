// ==========================================================================
// Finora — modules/preferences.js
// ==========================================================================

import { withTransaction, reqToPromise } from '../core/db.js';

export const OPTIONAL_MODULES = ['people', 'loans', 'bidsave', 'savings', 'recurring'];

export async function getSetting(key, fallback = null) {
  return withTransaction(['settings'], 'readonly', async (tx) => {
    const rec = await reqToPromise(tx.objectStore('settings').get(key));
    return rec?.value ?? fallback;
  });
}

export async function setSetting(key, value) {
  return withTransaction(['settings'], 'readwrite', (tx) => {
    tx.objectStore('settings').put({ key, value });
  });
}

/** All optional modules default to enabled until the user turns one off. */
export async function getEnabledModules() {
  const stored = await getSetting('enabledModules', null);
  const defaults = Object.fromEntries(OPTIONAL_MODULES.map((m) => [m, true]));
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
