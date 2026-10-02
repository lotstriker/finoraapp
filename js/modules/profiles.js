// ==========================================================================
// Finora — modules/profiles.js
// Household Profiles: each profile has a COMPLETELY SEPARATE dataset —
// its own accounts, transactions, everything — implemented as its own
// IndexedDB database rather than tagging every record with a profileId.
// This is deliberately the lower-risk design: db.js and every other
// module already only ever operate on "whichever database is currently
// open" without knowing or caring which profile that represents, so
// switching profiles just means closing one database and opening a
// different one — no changes needed anywhere else in the app.
//
// The profile REGISTRY itself (names, which db each maps to, which is
// active) lives in localStorage, not inside any profile's own database
// — it has to live somewhere that isn't itself profile-specific.
//
// Backward compatibility: an existing installation's current data lives
// in a database literally named 'finora'. The first time this module
// runs, if no registry exists yet, it creates a "Default" profile that
// points at that EXACT existing name — so nothing is lost or migrated,
// existing users just find their current data waiting under "Default".
// ==========================================================================

const REGISTRY_KEY = 'finora.profiles';
const ACTIVE_KEY = 'finora.activeProfileId';
const LEGACY_DB_NAME = 'finora';
const MAX_PROFILES = 6;

function newProfileId() {
  return `prof_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function readRegistry() {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeRegistry(profiles) {
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(profiles));
}

/** Ensures a registry exists — auto-creates a "Default" profile pointing at the pre-existing database on first run. */
function ensureRegistry() {
  let profiles = readRegistry();
  if (profiles && profiles.length > 0) return profiles;

  const defaultProfile = {
    id: newProfileId(),
    name: 'Default',
    emoji: '👤',
    dbName: LEGACY_DB_NAME,
    createdAt: new Date().toISOString(),
  };
  profiles = [defaultProfile];
  writeRegistry(profiles);
  localStorage.setItem(ACTIVE_KEY, defaultProfile.id);
  return profiles;
}

/** All profiles, in creation order. */
export function getProfiles() {
  return ensureRegistry();
}

export function getActiveProfileId() {
  ensureRegistry();
  return localStorage.getItem(ACTIVE_KEY);
}

export function getActiveProfile() {
  const profiles = getProfiles();
  const activeId = getActiveProfileId();
  return profiles.find((p) => p.id === activeId) || profiles[0];
}

/** The database name the currently-active profile should open — this is what db.js reads. */
export function getActiveDbName() {
  return getActiveProfile().dbName;
}

/**
 * Creates a new profile with its own fresh, empty database. Does NOT
 * switch to it — call switchProfile() separately once the caller is
 * ready to reload.
 */
export function createProfile({ name, emoji }) {
  const profiles = getProfiles();
  if (profiles.length >= MAX_PROFILES) {
    throw new Error(`You can have up to ${MAX_PROFILES} profiles.`);
  }
  if (!name || !name.trim()) {
    throw new Error('Give this profile a name.');
  }
  const profile = {
    id: newProfileId(),
    name: name.trim(),
    emoji: emoji || '👤',
    dbName: `finora_${newProfileId()}`,
    createdAt: new Date().toISOString(),
  };
  writeRegistry([...profiles, profile]);
  return profile;
}

export function renameProfile(id, newName) {
  if (!newName || !newName.trim()) throw new Error('Give this profile a name.');
  const profiles = getProfiles().map((p) => (p.id === id ? { ...p, name: newName.trim() } : p));
  writeRegistry(profiles);
}

/**
 * Removes a profile from the registry and deletes its underlying
 * database. Refuses to delete the last remaining profile, and refuses
 * to delete the currently-active one (switch away first).
 */
export async function deleteProfile(id) {
  const profiles = getProfiles();
  if (profiles.length <= 1) throw new Error("You can't delete your only profile.");
  if (id === getActiveProfileId()) throw new Error('Switch to a different profile before deleting this one.');

  const toDelete = profiles.find((p) => p.id === id);
  if (!toDelete) throw new Error('Profile not found.');

  writeRegistry(profiles.filter((p) => p.id !== id));

  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(toDelete.dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // another tab has it open — registry entry is gone either way
  });
}

/**
 * Marks a profile active. The caller is responsible for reloading the
 * page afterward (a fresh boot is the simplest, safest way to swap
 * which IndexedDB database the whole app is talking to).
 */
export function switchProfile(id) {
  const profiles = getProfiles();
  if (!profiles.some((p) => p.id === id)) throw new Error('Profile not found.');
  localStorage.setItem(ACTIVE_KEY, id);
}
