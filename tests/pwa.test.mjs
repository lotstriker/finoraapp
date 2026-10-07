import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { buildPrecache } from '../scripts/gen-precache.mjs';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

test('precache.js is up to date (run `npm run build:sw` after changing any app file)', () => {
  assert.equal(read('precache.js'), buildPrecache());
});

test('manifest: installable (name, start_url, standalone, 192 + 512 + maskable icons that exist)', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.ok(m.name && m.short_name && m.start_url);
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(existsSync(new URL(i.src, root)), `${i.src} missing`);
});

test('index.html links the manifest and CSP allows manifest + worker', () => {
  const html = read('index.html');
  assert.match(html, /rel="manifest"/);
  assert.match(html, /worker-src 'self'/);
});

/* ---------- run sw.js against a fake service-worker environment ---------- */
function loadSw({ network }) {
  const listeners = {}; const store = new Map(); const calls = { fetched: [] };
  const mkCache = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    const key = (req) => new URL(typeof req === 'string' ? req : req.url, 'https://app.test/').href;   // like the real Cache API: relative urls resolve against the scope
    return { match: async (req) => m.get(key(req)) || undefined,
             put: async (req, res) => { m.set(key(req), res); },
             add: async (url) => { m.set(new URL(url, 'https://app.test/').href, new Response('precached ' + url)); } };
  };
  const sandbox = {
    self: { location: { origin: 'https://app.test' }, addEventListener: (t, fn) => { listeners[t] = fn; },
            skipWaiting: async () => {}, clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} } },
    caches: { open: async (n) => mkCache(n), keys: async () => [...store.keys()], delete: async (n) => store.delete(n) },
    importScripts: (f) => vm.runInContext(readFileSync(new URL(f.replace('./', ''), root), 'utf8'), sandbox),
    fetch: async (req) => { calls.fetched.push(req.url || String(req)); return network(req); },
    Response, URL, setTimeout, clearTimeout, Promise, Error,
  };
  sandbox.self.__proto__ = sandbox.self.__proto__; vm.createContext(sandbox);
  sandbox.globalThis = sandbox; sandbox.self.caches = sandbox.caches;
  // `self` must also hold the precache globals set by importScripts
  vm.runInContext("var self = this.self;", sandbox);
  vm.runInContext(readFileSync(new URL('sw.js', root), 'utf8').replace(/self\./g, 'self.'), Object.assign(sandbox, {}));
  return { listeners, store, calls, sandbox };
}
const evt = (url, extra = {}) => { let p; return { request: { url, method: 'GET', mode: 'cors', ...extra }, respondWith: (x) => { p = x; }, get response() { return p; } }; };

test('sw: install precaches every app file; activate removes OLD caches only', async () => {
  const { listeners, store, sandbox } = loadSw({ network: async () => new Response('x') });
  store.set('finora-oldversion', new Map());
  let done; listeners.install({ waitUntil: (p) => { done = p; } }); await done;
  const cached = [...[...store.entries()].find(([k]) => k.startsWith('finora-') && k !== 'finora-oldversion')[1].keys()];
  assert.ok(cached.some((u) => u.endsWith('/js/app.js')));
  assert.ok(cached.some((u) => u.endsWith('/css/variables.css')));
  assert.ok(cached.some((u) => u.endsWith('/index.html')));
  listeners.activate({ waitUntil: (p) => { done = p; } }); await done;
  assert.equal(store.has('finora-oldversion'), false);
});

test('sw: serves from the network when online and from cache when offline', async () => {
  let online = true;
  const { listeners } = loadSw({ network: async () => { if (!online) throw new Error('offline'); return new Response('fresh'); } });
  let installed; listeners.install({ waitUntil: (p) => { installed = p; } }); await installed;   // app shell precached on install
  let e = evt('https://app.test/js/app.js'); listeners.fetch(e);
  assert.equal(await (await e.response).text(), 'fresh');
  online = false;
  e = evt('https://app.test/js/app.js'); listeners.fetch(e);
  assert.equal(await (await e.response).text(), 'fresh');            // cached copy from the online visit
  e = evt('https://app.test/#/dashboard', { mode: 'navigate' }); listeners.fetch(e);
  assert.ok(await e.response, 'offline navigation falls back to the app shell');
});

test('sw: never intercepts Google sign-in / Drive, or non-GET requests', () => {
  const { listeners } = loadSw({ network: async () => new Response('x') });
  for (const u of ['https://accounts.google.com/gsi/client', 'https://www.googleapis.com/drive/v3/files', 'https://oauth2.googleapis.com/token']) {
    const e = evt(u); listeners.fetch(e); assert.equal(e.response, undefined, u);
  }
  const post = evt('https://app.test/x', { method: 'POST' }); listeners.fetch(post); assert.equal(post.response, undefined);
});

/* ---------- notifications ---------- */
test('notifications: uses the service-worker API (Android), falls back to the constructor, never throws', async () => {
  const { showNotification } = await import('../js/modules/notifications.js');
  const shown = [];
  const setNav = (v) => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });
  setNav({ serviceWorker: { getRegistration: async () => ({ showNotification: async (t, o) => { shown.push(['sw', t, o.body]); } }) } });
  assert.equal(await showNotification('Bill due', { body: 'Rent' }), true);
  assert.deepEqual(shown[0], ['sw', 'Bill due', 'Rent']);

  setNav({ serviceWorker: { getRegistration: async () => undefined } });
  globalThis.Notification = class { constructor(t) { shown.push(['ctor', t]); } };
  assert.equal(await showNotification('X'), true);
  assert.deepEqual(shown[1], ['ctor', 'X']);

  globalThis.Notification = class { constructor() { throw new TypeError('Illegal constructor'); } };   // Android Chrome without SW
  assert.equal(await showNotification('Y'), false);
});
