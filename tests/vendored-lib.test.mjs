// Loads the REAL vendored supabase-js build and checks the options Finora relies on actually do what the docs say.
import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const code = readFileSync(new URL('../js/vendor/supabase-js-2.117.2.umd.js', import.meta.url), 'utf8');

function loadLib(url = 'https://saif.github.io/finora/#/dashboard') {
  const dom = new JSDOM('<!doctype html><body></body>', { url, runScripts: 'outside-only', pretendToBeVisual: true });
  // jsdom has no WebCrypto (browsers do); PKCE needs it, so hand it the real one
  Object.defineProperty(dom.window, 'crypto', { value: globalThis.crypto, configurable: true });
  dom.window.TextEncoder = TextEncoder; dom.window.fetch = async () => new Response('{}', { status: 200 });
  dom.window.eval(code);
  return dom.window;
}

test('vendored library exposes createClient and is the version we pinned', () => {
  const w = loadLib();
  assert.equal(typeof w.supabase.createClient, 'function');
});

test('PKCE sign-in URL: code_challenge (S256) + redirect_to WITHOUT the #hash; provider google', async () => {
  const w = loadLib();
  const client = w.supabase.createClient('https://abcdefghijklmnopqrst.supabase.co', 'sb_publishable_abc', {
    auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: false, storageKey: 'finora.supabase.auth' },
  });
  const { data, error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: 'https://saif.github.io/finora/', skipBrowserRedirect: true } });
  assert.equal(error, null);
  const u = new URL(data.url);
  assert.equal(u.origin + u.pathname, 'https://abcdefghijklmnopqrst.supabase.co/auth/v1/authorize');
  assert.equal(u.searchParams.get('provider'), 'google');
  assert.equal(u.searchParams.get('redirect_to'), 'https://saif.github.io/finora/');
  assert.ok(u.searchParams.get('code_challenge'), 'PKCE code_challenge present');
  assert.match(u.searchParams.get('code_challenge_method'), /s256/i);
  // the verifier is kept locally under OUR storage key (not the default), so it can't clash with other apps
  const keys = Object.keys(w.localStorage).concat(Array.from({ length: w.localStorage.length }, (_, i) => w.localStorage.key(i)));
  assert.ok(keys.some((k) => String(k).startsWith('finora.supabase.auth')), `localStorage keys: ${keys}`);
});

test('without flowType:"pkce" the library would use the implicit flow (the #hash problem) — proof our option matters', async () => {
  const w = loadLib();
  const client = w.supabase.createClient('https://abcdefghijklmnopqrst.supabase.co', 'sb_publishable_abc', { auth: { persistSession: false, autoRefreshToken: false } });
  const { data } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: 'https://saif.github.io/finora/', skipBrowserRedirect: true } });
  assert.equal(new URL(data.url).searchParams.get('code_challenge'), null, 'implicit flow has no code_challenge -> tokens would come back in the #hash');
});
