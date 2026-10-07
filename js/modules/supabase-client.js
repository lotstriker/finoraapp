// ==========================================================================
// Finora — modules/supabase-client.js
// Sign-in + the Supabase client. Cross-checked against the Supabase docs:
//   * supabase-js v2 default is the IMPLICIT flow, which returns tokens in the URL #hash — that
//     collides with Finora's hash router (#/dashboard). So we use PKCE (`flowType:'pkce'`), which
//     returns a one-time `?code=` in the QUERY string; we exchange it and then clean the URL.
//   * The OAuth redirect URL must be allow-listed in Auth -> URL Configuration.
//   * Only the publishable/anon key is ever used in the browser (never the secret/service_role key).
//   * The library (v2.117.2, MIT) is vendored in js/vendor/ and loaded only when sync is used.
// ==========================================================================

import { SUPABASE_CONFIG } from '../config.js';

const LIB_PATH = 'js/vendor/supabase-js-2.117.2.umd.js';
const AUTH_STORAGE_KEY = 'finora.supabase.auth';

let config = { ...SUPABASE_CONFIG };
let libPromise = null;
let clientPromise = null;
let createClientOverride = null;

/** Runtime override (deployments / tests). `createClient` lets tests inject a fake client. */
export function configureSupabase({ url, key, createClient } = {}) {
  if (url !== undefined) config.url = url;
  if (key !== undefined) config.key = key;
  if (createClient !== undefined) createClientOverride = createClient;
  clientPromise = null;
}

/** Decodes a JWT payload (no verification — only used to recognise a service_role key). */
function jwtRole(jwt) {
  try {
    const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='))).role;
  } catch { return null; }
}

/**
 * Checks the URL/key a deployer pasted into config.js.
 * Returns { ok: true } or { ok: false, problem } — including a hard refusal of secret keys, because a
 * secret key in a public GitHub repo would hand the whole database to anyone.
 */
export function validateSupabaseConfig({ url, key } = config) {
  if (!url || !key) return { ok: false, problem: 'Server sync is not configured yet (add your Supabase URL and key in js/config.js).' };
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url.replace(/\/$/, ''))) {
    return { ok: false, problem: 'The Supabase URL should look like https://<project-ref>.supabase.co' };
  }
  if (/^sb_secret_/i.test(key) || jwtRole(key) === 'service_role') {
    return { ok: false, problem: 'That is a SECRET key (service_role). Never put it in browser code. Use the publishable / anon key instead.' };
  }
  if (!/^sb_publishable_/i.test(key) && !/^eyJ/.test(key)) {
    return { ok: false, problem: 'The key should be the publishable key (sb_publishable_…) or the legacy anon key (eyJ…).' };
  }
  return { ok: true };
}

export const isSupabaseConfigured = () => validateSupabaseConfig().ok;

/** Where Google should send the user back to: this page WITHOUT the #hash route (so it matches the allow-list). */
export function appReturnUrl() {
  return `${location.origin}${location.pathname}`;
}

function loadLibrary() {
  if (createClientOverride) return Promise.resolve(createClientOverride);
  if (libPromise) return libPromise;
  libPromise = new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && window.supabase?.createClient) { resolve(window.supabase.createClient); return; }
    const script = document.createElement('script');
    script.src = LIB_PATH;
    script.async = true;
    script.onload = () => (window.supabase?.createClient ? resolve(window.supabase.createClient) : reject(new Error('Sync library did not load.')));
    script.onerror = () => reject(new Error('Could not load the sync library.'));
    document.head.appendChild(script);
  });
  libPromise.catch(() => { libPromise = null; });
  return libPromise;
}

/** The (lazily created) Supabase client. Throws a plain Error if sync isn't configured. */
export function getClient() {
  if (clientPromise) return clientPromise;
  const check = validateSupabaseConfig();
  if (!check.ok) return Promise.reject(new Error(check.problem));
  clientPromise = loadLibrary().then((createClient) => createClient(config.url.replace(/\/$/, ''), config.key, {
    auth: {
      flowType: 'pkce',               // `?code=` in the query string, NOT tokens in the #hash (hash router!)
      detectSessionInUrl: true,       // exchanges the ?code= automatically on load
      persistSession: true,
      autoRefreshToken: true,
      storageKey: AUTH_STORAGE_KEY,
    },
    realtime: { params: { eventsPerSecond: 5 } },
  }));
  clientPromise.catch(() => { clientPromise = null; });
  return clientPromise;
}

/* ---------------------------------------------------------------------- */
/* Auth                                                                   */
/* ---------------------------------------------------------------------- */

/** Current session, or null. Awaiting this also waits for a pending ?code= exchange. */
export async function getSession() {
  const client = await getClient();
  const { data, error } = await client.auth.getSession();
  if (error) throw new Error(error.message);
  return data?.session || null;
}

export async function getUser() {
  return (await getSession())?.user || null;
}

/** Starts Google sign-in (full-page redirect). Come back via handleAuthReturn(). */
export async function signInWithGoogle() {
  const client = await getClient();
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: appReturnUrl() },
  });
  if (error) throw new Error(error.message);
}

export async function signOut() {
  const client = await getClient();
  const { error } = await client.auth.signOut();
  if (error) throw new Error(error.message);
}

/** Subscribes to sign-in / sign-out / token refresh. Returns an unsubscribe function. */
export async function onAuthChange(callback) {
  const client = await getClient();
  const { data } = client.auth.onAuthStateChange((event, session) => callback(event, session));
  return () => data.subscription.unsubscribe();
}

/**
 * Call once at startup. If the URL carries an OAuth result (`?code=…` or `?error=…`), wait for the
 * client to finish the exchange, then remove those params so a refresh doesn't replay them — keeping
 * the #hash route intact. Never throws; returns { handled, error? }.
 */
export async function handleAuthReturn() {
  const params = new URLSearchParams(location.search);
  const returning = params.has('code') || params.has('error') || params.has('error_description');
  if (!returning || !isSupabaseConfigured()) return { handled: false };
  let error;
  try {
    await getSession();                                 // waits for the PKCE exchange
  } catch (e) { error = e.message; }
  if (params.get('error_description')) error = params.get('error_description');
  for (const k of ['code', 'error', 'error_code', 'error_description']) params.delete(k);
  const qs = params.toString();
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
  return { handled: true, error };
}
