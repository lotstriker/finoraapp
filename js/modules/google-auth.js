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

// Set this after completing the Google Cloud Console setup (see README/
// setup notes) — it is a PUBLIC identifier, not a secret. Google's own
// security model for browser apps relies on the Authorized JavaScript
// Origins allow-list configured in Cloud Console, not on hiding this ID.
const CLIENT_ID = 'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com';

const SCOPES = 'https://www.googleapis.com/auth/drive.appdata email openid';

const CONNECTED_KEY = 'finora.google.connected';
const EMAIL_KEY = 'finora.google.email';
const STABLE_ID_KEY = 'finora.google.stableId';

let accessToken = null;
let gisLoadPromise = null;

export function isGoogleConfigured() {
  return !!CLIENT_ID && !CLIENT_ID.startsWith('YOUR_');
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

/** The current session's access token, if any (null until connect()/trySilentReconnect() succeeds this session). */
export function getAccessToken() {
  return accessToken;
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
 * Triggers the Google sign-in / consent popup. Resolves with the
 * connected email on success; rejects with a plain, user-facing Error
 * on cancellation or failure.
 */
export async function connectGoogleAccount() {
  if (!isGoogleConfigured()) throw new Error('Google backup is not configured for this deployment yet.');
  const loaded = await loadGis();
  if (!loaded) throw new Error('Could not load Google Sign-In — check your connection and try again.');

  return new Promise((resolve, reject) => {
    try {
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: async (response) => {
          if (response.error) { reject(new Error('Google sign-in was cancelled.')); return; }
          accessToken = response.access_token;
          try {
            const info = await fetchUserInfo(accessToken);
            localStorage.setItem(CONNECTED_KEY, 'true');
            localStorage.setItem(EMAIL_KEY, info.email || '');
            localStorage.setItem(STABLE_ID_KEY, info.sub || info.email || '');
            resolve(info.email);
          } catch {
            reject(new Error('Connected, but could not read your Google account info.'));
          }
        },
        error_callback: () => reject(new Error('Google sign-in was cancelled.')),
      });
      tokenClient.requestAccessToken({ prompt: 'consent' });
    } catch {
      reject(new Error('Could not start Google sign-in.'));
    }
  });
}

/**
 * Tries to silently re-obtain an access token for an already-connected
 * account (call this once on app load). Never shows a popup; resolves
 * false (never rejects) if silent reconnection isn't possible — the
 * caller just treats the user as "not currently connected" and moves on.
 */
export async function trySilentReconnect() {
  if (!isConnected() || !isGoogleConfigured()) return false;
  const loaded = await loadGis();
  if (!loaded) return false;

  return new Promise((resolve) => {
    try {
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (response) => {
          if (response.error) { resolve(false); return; }
          accessToken = response.access_token;
          resolve(true);
        },
        error_callback: () => resolve(false),
      });
      tokenClient.requestAccessToken({ prompt: '' });
    } catch {
      resolve(false);
    }
  });
}

/** Revokes the token and forgets the connected account on this device. */
export function disconnectGoogleAccount() {
  if (accessToken && window.google?.accounts?.oauth2?.revoke) {
    try { window.google.accounts.oauth2.revoke(accessToken, () => {}); } catch { /* best effort */ }
  }
  accessToken = null;
  localStorage.removeItem(CONNECTED_KEY);
  localStorage.removeItem(EMAIL_KEY);
  localStorage.removeItem(STABLE_ID_KEY);
}
