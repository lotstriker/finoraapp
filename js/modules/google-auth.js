// ==========================================================================
// Finora — modules/google-auth.js
// Google Sign-In via Google Identity Services (GIS) — a pure-frontend,
// no-backend, no-client-secret OAuth flow purpose-built for static
// sites like this one. Requests only:
//   - drive.appdata: Google Drive's hidden "App Data" folder — invisible
//     in the user's normal Drive UI, readable only by this exact app for
//     this exact signed-in Google account (not by other apps, not by
//     other Google users).
//   - email: just enough to show "Connected as ..." in Settings, and to
//     derive a stable per-account key for encrypting backups (see
//     google-drive-backup.js) without the user ever typing a password.
//
// Every function here is written to fail softly: if the network is
// down, the Google script is blocked, or the user cancels, callers get
// a plain rejected Promise/Error — nothing here ever throws
// uncaught or leaves Finora's normal (offline) operation unusable.
// ==========================================================================

// Paste your OAuth Web client ID here (Google Cloud Console -> Credentials).
// It is a PUBLIC identifier, not a secret — Google's security model for
// browser apps relies on the Authorized JavaScript Origins allow-list, not on
// hiding this ID. Real IDs look like 1234567890-abcdef.apps.googleusercontent.com
let CLIENT_ID = 'PASTE_YOUR_CLIENT_ID_HERE';

/** Sets the client id at runtime (e.g. from a deployment config, or in tests). Must look like 123-abc.apps.googleusercontent.com. */
export function configureGoogleClient(id) {
  CLIENT_ID = String(id || '');
}

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const SCOPES = `${DRIVE_SCOPE} email openid`;

const CONNECTED_KEY = 'finora.google.connected';
const EMAIL_KEY = 'finora.google.email';
const STABLE_ID_KEY = 'finora.google.stableId';

let accessToken = null;
let tokenExpiresAt = 0;
let gisLoadPromise = null;

export function isGoogleConfigured() {
  // Only a value shaped like a real Google client ID counts as configured, so a
  // placeholder never shows a "Connect" button that can't possibly work.
  return /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(CLIENT_ID);
}

export function isConnected() {
  return localStorage.getItem(CONNECTED_KEY) === 'true';
}

export function getConnectedEmail() {
  return localStorage.getItem(EMAIL_KEY);
}

/** The stable identifier used to derive this account's backup encryption key — never changes for a given Google account. */
export function getStableAccountId() {
  return localStorage.getItem(STABLE_ID_KEY);
}

/**
 * The current access token — or null if there is none OR it is (nearly) expired.
 * Google access tokens only live ~1 hour; handing out a dead one just produced
 * confusing 401s.
 */
export function getAccessToken() {
  return accessToken && Date.now() < tokenExpiresAt - 30000 ? accessToken : null;
}

/** Lazily loads Google's Identity Services script. Never throws — resolves false on any failure (offline, blocked, etc). */
function loadGis() {
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve) => {
    if (typeof window === 'undefined') { resolve(false); return; }
    if (window.google?.accounts?.oauth2) { resolve(true); return; }
    try {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve(!!window.google?.accounts?.oauth2);
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
      setTimeout(() => resolve(!!window.google?.accounts?.oauth2), 8000); // never hang forever
    } catch {
      resolve(false);
    }
  });
  return gisLoadPromise;
}

async function fetchUserInfo(token) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Could not read your Google account info.');
  return res.json();
}

/**
 * One place that talks to the GIS token client.
 *   prompt 'consent' -> always show the consent screen (first connect)
 *   prompt ''        -> may show a popup; MUST come from a user click or browsers block it
 *   prompt 'none'    -> never shows UI; fails quietly if Google can't answer silently
 * Resolves {ok:true, response} or {ok:false, error} — never rejects.
 */
function requestToken(prompt) {
  return new Promise((resolve) => {
    try {
      // login_hint (Google docs): when we already know the account, account selection is
      // skipped — so a reconnect doesn't ask "which account?" and silent refresh targets the right one.
      const hint = localStorage.getItem(EMAIL_KEY) || undefined;
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        ...(hint ? { login_hint: hint } : {}),
        callback: (response) => resolve(response?.error ? { ok: false, error: response.error } : { ok: true, response }),
        error_callback: (err) => resolve({ ok: false, error: err?.type || 'popup_failed' }),
      });
      client.requestAccessToken({ prompt });
    } catch {
      resolve({ ok: false, error: 'init_failed' });
    }
  });
}

/**
 * Stores the token — but ONLY if the user actually granted Drive access. Google's
 * consent screen lets people untick individual permissions ("granular
 * permissions"); without this check a half-granted token connected "successfully"
 * and every backup then failed with an unexplained 403.
 */
function acceptToken(response) {
  const granted = window.google.accounts.oauth2.hasGrantedAllScopes?.(response, DRIVE_SCOPE);
  if (granted === false) return { ok: false, error: 'scope_missing' };
  accessToken = response.access_token;
  tokenExpiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000;
  return { ok: true };
}

const SCOPE_MESSAGE = 'Drive access was not granted. On the Google screen, tick the Google Drive permission ("See, create, and delete its own configuration data") and try again.';

/**
 * Triggers the Google sign-in / consent popup (call from a click). Resolves with the
 * connected email; rejects with a plain, user-facing Error on cancellation or failure.
 */
export async function connectGoogleAccount({ prompt = 'consent' } = {}) {
  if (!isGoogleConfigured()) throw new Error('Google backup is not configured for this deployment yet.');
  const loaded = await loadGis();
  if (!loaded) throw new Error('Could not load Google Sign-In — check your connection and try again.');

  const r = await requestToken(prompt);
  if (!r.ok) throw new Error('Google sign-in was cancelled.');
  const accepted = acceptToken(r.response);
  if (!accepted.ok) throw new Error(SCOPE_MESSAGE);

  try {
    const info = await fetchUserInfo(accessToken);
    localStorage.setItem(CONNECTED_KEY, 'true');
    localStorage.setItem(EMAIL_KEY, info.email || '');
    localStorage.setItem(STABLE_ID_KEY, info.sub || info.email || '');
    return info.email;
  } catch {
    throw new Error('Connected, but could not read your Google account info.');
  }
}

/**
 * Quietly re-obtains a token for an already-connected account (call on page load).
 * Uses prompt:'none' so it can never open a popup that a browser would block — it just
 * returns false when Google can't answer silently, and the UI shows a "Reconnect" button.
 */
export async function trySilentReconnect() {
  if (!isConnected() || !isGoogleConfigured()) return false;
  if (!(await loadGis())) return false;
  const r = await requestToken('none');
  return r.ok && acceptToken(r.response).ok;
}

/**
 * Returns a usable access token, refreshing an expired one first. Pass
 * interactive:true only from a user click (e.g. the Backup Now button) — that
 * lets Google show its popup if it has to.
 */
export async function ensureAccessToken({ interactive = false } = {}) {
  const existing = getAccessToken();
  if (existing) return existing;
  if (!isConnected() || !isGoogleConfigured()) return null;
  if (!(await loadGis())) return null;
  const r = await requestToken(interactive ? '' : 'none');
  if (!r.ok || !acceptToken(r.response).ok) return null;
  return accessToken;
}

/** Forgets the token (e.g. after a 401) so the next call refreshes it. */
export function invalidateAccessToken() {
  accessToken = null;
  tokenExpiresAt = 0;
}

/** Revokes the token and forgets the connected account on this device. */
export function disconnectGoogleAccount() {
  if (accessToken && window.google?.accounts?.oauth2?.revoke) {
    try { window.google.accounts.oauth2.revoke(accessToken, () => {}); } catch { /* best effort */ }
  }
  invalidateAccessToken();
  localStorage.removeItem(CONNECTED_KEY);
  localStorage.removeItem(EMAIL_KEY);
  localStorage.removeItem(STABLE_ID_KEY);
}
