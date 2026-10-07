// A tiny fake of Google Identity Services + Drive v3 (appDataFolder), shared by the Drive and auto-sync tests.
// Mirrors the documented behaviour: monotonically increasing `version`, modifiedTime, multipart + resumable
// uploads (PATCH to update), files.list with spaces=appDataFolder, alt=media downloads, rate-limit/5xx errors.
import { configureGoogleClient } from '../js/modules/google-auth.js';

export const G = {
  files: new Map(), clock: Date.UTC(2026, 9, 5), versionSeq: 100,
  grantAll: true, silentOk: true, tokens: 0, prompts: [], calls: [], hints: [],
  fail: null,           // { match: (method,url)=>bool, status, reason, times }
};

export function resetGoogle() {
  G.files = new Map(); G.clock = Date.UTC(2026, 9, 5); G.versionSeq = 100;
  G.grantAll = true; G.silentOk = true; G.tokens = 0; G.prompts = []; G.calls = []; G.hints = []; G.fail = null;
}

const J = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
const touch = (f) => { f.modifiedTime = new Date(++G.clock).toISOString(); f.version = String(++G.versionSeq); };

/** Simulates "another device uploaded": bumps version + modifiedTime. */
export function otherDeviceWrites(fileId) { touch(G.files.get(fileId)); }

export function installFakeGoogle() {
  configureGoogleClient('123456-test.apps.googleusercontent.com');
  globalThis.window = globalThis;
  window.google = { accounts: { oauth2: {
    initTokenClient: ({ callback, login_hint }) => ({ requestAccessToken: ({ prompt }) => {
      G.prompts.push(prompt); G.hints.push(login_hint);
      setTimeout(() => {
        if (prompt === 'none' && !G.silentOk) return callback({ error: 'interaction_required' });
        callback({ access_token: 'tok-' + (++G.tokens), expires_in: 3600, scope: 'x' });
      }, 0);
    } }),
    hasGrantedAllScopes: () => G.grantAll,
    revoke: () => {},
  } } };
  localStorage.setItem('finora.google.connected', 'true');
  localStorage.setItem('finora.google.email', 'me@example.com');
  localStorage.setItem('finora.google.stableId', '1234567890');

  globalThis.fetch = async (url, opts = {}) => {
    url = String(url); const method = (opts.method || 'GET').toUpperCase();
    G.calls.push(`${method} ${url.replace('https://www.googleapis.com', '')}`);
    if (G.fail && G.fail.match(method, url) && (G.fail.times ?? 1) > 0) {
      G.fail.times = (G.fail.times ?? 1) - 1;
      if (G.fail.network) throw new TypeError('network down');
      return J({ error: { code: G.fail.status, message: 'injected', errors: [{ reason: G.fail.reason || '' }] } }, G.fail.status);
    }
    if (url.includes('/oauth2/v3/userinfo')) return J({ email: 'me@example.com', sub: '1234567890' });
    if (url.startsWith('https://upload.session/')) {
      const id = url.split('/').pop(); const f = G.files.get(id);
      f.content = new TextDecoder().decode(opts.body); f.size = opts.body.length; touch(f);
      return J({ id, modifiedTime: f.modifiedTime, version: f.version });
    }
    if (url.includes('/upload/drive/v3/files')) {
      const u = new URL(url); const kind = u.searchParams.get('uploadType');
      let id = u.pathname.match(/files\/([^/]+)$/)?.[1];
      if (kind === 'resumable') {
        if (method === 'PUT') return new Response('{}', { status: 200 });          // docs: PUT returns no Location
        const meta = JSON.parse(opts.body);
        if (!id) { id = 'f' + (G.files.size + 1); G.files.set(id, { id, name: meta.name, appProperties: meta.appProperties, content: '' }); touch(G.files.get(id)); }
        else Object.assign(G.files.get(id), { appProperties: meta.appProperties });
        return new Response('{}', { status: 200, headers: { Location: `https://upload.session/${id}` } });
      }
      const boundary = opts.headers['Content-Type'].split('boundary=')[1];
      const parts = opts.body.split(`--${boundary}`).filter((p) => p.trim() && p.trim() !== '--');
      const body = (p) => p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
      const meta = JSON.parse(body(parts[0])); const content = body(parts[1]);
      // Drive rejects custom properties over 124 bytes (key + value, UTF-8) with a 400
      for (const [k, v] of Object.entries(meta.appProperties || {})) {
        if (new TextEncoder().encode(k + v).length > 124) return J({ error: { code: 400, message: 'property too large' } }, 400);
      }
      if (!id) { id = 'f' + (G.files.size + 1); G.files.set(id, { id, name: meta.name }); }
      const f = G.files.get(id); Object.assign(f, { appProperties: meta.appProperties, content, size: content.length }); touch(f);
      return J({ id, modifiedTime: f.modifiedTime, version: f.version });
    }
    if (url.includes('alt=media')) return new Response(G.files.get(url.split('/files/')[1].split('?')[0]).content);
    if (url.includes('/drive/v3/files')) {
      const list = [...G.files.values()].sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
      return J({ files: list.map(({ content, ...rest }) => rest) });
    }
    return J({}, 404);
  };
}
