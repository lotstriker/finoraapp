// ==========================================================================
// Finora — modules/e2e-crypto.js
// END-TO-END ENCRYPTION for server sync. The key is derived from the user's PASSPHRASE on this
// device; the server only ever receives ciphertext and can never decrypt it.
//
//   passphrase --PBKDF2-HMAC-SHA256 (600,000 iterations; OWASP)--> AES-256-GCM key (non-extractable)
//   each record: random 96-bit IV, AAD = "dataset|store|record_id"  -> base64(iv || ciphertext+tag)
//
// * AAD binds a ciphertext to WHERE it belongs: a malicious/buggy server cannot move one record's
//   ciphertext into another record (decryption would fail the GCM check).
// * Salt + a "verifier" (a known string encrypted with the key) are stored server-side so a second
//   device can derive the same key and check the passphrase — neither reveals the key.
// * The derived key is kept on THIS device as a non-extractable CryptoKey in IndexedDB so you aren't
//   asked every launch. Non-extractable = JavaScript cannot read the raw key bytes (it can still use
//   it, so protecting against XSS remains the CSP's job).
// * LOST PASSPHRASE = LOST SYNCED DATA ON THE SERVER (nobody can recover it — that's the point).
//   Your local data and your Drive / .finora backups are unaffected.
// ==========================================================================

import { getSetting, setSetting } from './preferences.js';

export const E2E_KDF_ITERATIONS = 600000;
export const E2E_KEY_SETTING = 'e2eKey';
const VERIFIER_TEXT = 'finora-e2e-v1';
export const MIN_PASSPHRASE_LENGTH = 10;

export class E2EError extends Error {
  constructor(message, code) { super(message); this.name = 'E2EError'; this.code = code; }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export const toB64 = (bytes) => {
  let s = ''; const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Length rule + a plain-language hint. (An attacker with a server dump can try guesses offline, so length matters.) */
export function assessPassphrase(passphrase) {
  const p = String(passphrase ?? '');
  if (p.length < MIN_PASSPHRASE_LENGTH) return { ok: false, problem: `Use at least ${MIN_PASSPHRASE_LENGTH} characters — 4 or 5 random words is ideal.` };
  if (/^(.)\1+$/.test(p) || /^(0123456789|1234567890|password|passphrase)/i.test(p)) return { ok: false, problem: 'That passphrase is too easy to guess.' };
  return { ok: true };
}

export async function deriveE2EKey(passphrase, saltB64, iterations = E2E_KDF_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(passphrase).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromB64(saltB64), iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/** Encrypts any JSON-able value. `aad` binds it to its location (see header). */
export async function encryptValue(key, value, aad = '') {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value)));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), iv.length);
  return toB64(out);
}

export async function decryptValue(key, b64, aad = '') {
  try {
    const raw = fromB64(b64);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(aad) }, key, raw.slice(12));
    return JSON.parse(dec.decode(pt));
  } catch {
    throw new E2EError('Could not decrypt a synced record — wrong passphrase, or the data was tampered with.', 'decrypt-failed');
  }
}

/** AAD used for synced records. */
export const recordAad = (datasetId, store, recordId) => `${datasetId}|${store}|${recordId}`;

/* ---------- passphrase setup (first device) and unlock (other devices) ---------- */

/** First device: new random salt + key + verifier to store on the server. */
export async function createEncryption(passphrase) {
  const check = assessPassphrase(passphrase);
  if (!check.ok) throw new E2EError(check.problem, 'weak-passphrase');
  const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveE2EKey(passphrase, salt, E2E_KDF_ITERATIONS);
  return { key, profile: { kdf_salt: salt, kdf_iterations: E2E_KDF_ITERATIONS, verifier: await encryptValue(key, VERIFIER_TEXT, 'verifier') } };
}

/** Other devices: derive from the stored salt and CHECK the passphrase against the stored verifier. */
export async function unlockEncryption(passphrase, profile) {
  const key = await deriveE2EKey(passphrase, profile.kdf_salt, Number(profile.kdf_iterations) || E2E_KDF_ITERATIONS);
  let text;
  try { text = await decryptValue(key, profile.verifier, 'verifier'); }
  catch { throw new E2EError('Wrong passphrase.', 'wrong-passphrase'); }
  if (text !== VERIFIER_TEXT) throw new E2EError('Wrong passphrase.', 'wrong-passphrase');
  return key;
}

/* ---------- keeping the key on this device ---------- */
export const saveLocalKey = (key, userId) => setSetting(E2E_KEY_SETTING, { key, userId, savedAt: new Date().toISOString() });
export async function loadLocalKey(userId) {
  const rec = await getSetting(E2E_KEY_SETTING, null);
  return rec && rec.key && (!userId || rec.userId === userId) ? rec.key : null;
}
export const forgetLocalKey = () => setSetting(E2E_KEY_SETTING, null);
