// ==========================================================================
// Finora — modules/server-account.js
// Ties sign-in (Supabase Auth) to the encryption passphrase.
//
//   Step 1  Sign in with Google (Supabase Auth)               -> who you are
//   Step 2  Passphrase:  first device  -> create it (salt + verifier saved on the server)
//                        other device  -> enter it  (checked against the verifier)
//   Step 3  The derived key is kept on this device (non-extractable) — sync can run.
// ==========================================================================

import { getClient, getUser } from './supabase-client.js';
import { createEncryption, unlockEncryption, saveLocalKey, loadLocalKey, forgetLocalKey, E2EError } from './e2e-crypto.js';

/** The server-side encryption profile (salt + verifier) for the signed-in user, or null. */
export async function getRemoteEncryptionProfile() {
  const client = await getClient();
  const { data, error } = await client.from('sync_profiles').select('kdf_salt,kdf_iterations,verifier').maybeSingle();
  if (error) throw new Error(`Could not read your sync profile: ${error.message}`);
  return data || null;
}

/**
 * Where is the user in the setup?
 *   'signed-out'   -> needs Google sign-in
 *   'needs-create' -> signed in, no passphrase yet (first device)
 *   'needs-unlock' -> signed in, passphrase exists on the server but this device doesn't have the key
 *   'ready'        -> key is on this device; sync can start
 */
export async function getSetupState() {
  const user = await getUser();
  if (!user) return { state: 'signed-out', user: null };
  if (await loadLocalKey(user.id)) return { state: 'ready', user };
  const profile = await getRemoteEncryptionProfile();
  return { state: profile ? 'needs-unlock' : 'needs-create', user, profile };
}

/** First device: choose the passphrase. Saves salt + verifier on the server and the key here. */
export async function setUpEncryption(passphrase) {
  const user = await getUser();
  if (!user) throw new E2EError('Sign in first.', 'signed-out');
  if (await getRemoteEncryptionProfile()) throw new E2EError('An encryption passphrase already exists for this account — enter it instead.', 'already-exists');
  const { key, profile } = await createEncryption(passphrase);
  const client = await getClient();
  const { error } = await client.from('sync_profiles').insert(profile);
  if (error) throw new Error(`Could not save your sync profile: ${error.message}`);
  await saveLocalKey(key, user.id);
  return true;
}

/** Another device: enter the existing passphrase. Throws E2EError('wrong-passphrase') if it doesn't match. */
export async function unlockWithPassphrase(passphrase) {
  const user = await getUser();
  if (!user) throw new E2EError('Sign in first.', 'signed-out');
  const profile = await getRemoteEncryptionProfile();
  if (!profile) throw new E2EError('No passphrase has been set up for this account yet.', 'no-profile');
  const key = await unlockEncryption(passphrase, profile);
  await saveLocalKey(key, user.id);
  return true;
}

/** Forget the key on THIS device (sign out of sync). Server data and other devices are untouched. */
export const lockThisDevice = forgetLocalKey;
export { loadLocalKey };
