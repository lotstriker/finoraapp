# Supabase setup for Finora server sync (about 15 minutes, free)

You do this once. Nothing here is secret except the passphrase you will choose in the app.

## 1. Create the project
1. Go to <https://supabase.com> -> **New project** (free plan is fine). Pick a region near you (e.g. Mumbai `ap-south-1`).
2. **Free plan rule (official pricing page): a project with no activity for 1 week is PAUSED.**
   Finora keeps working offline; to resume, open the dashboard and click *Restore*. Using the app (any sync) counts as activity.
   Pro plans are never paused.

## 2. Create the tables (one paste)
Dashboard -> **SQL Editor** -> *New query* -> paste the whole of `supabase/schema.sql` -> **Run**.
It is safe to run again later. (This repo's tests run that exact file on a real Postgres.)

## 3. Turn on Google sign-in
1. Google Cloud Console -> *APIs & Services* -> *Credentials* -> **Create OAuth client ID** -> type **Web application**.
   (This is separate from the client you use for Drive backup; you may reuse the Cloud project.)
2. **Authorized redirect URI:** `https://<your-project-ref>.supabase.co/auth/v1/callback`
   (Supabase shows the exact value under *Authentication -> Sign In / Providers -> Google*).
3. Copy the Google **Client ID** and **Client secret** into Supabase -> *Authentication -> Sign In / Providers -> Google* -> enable -> Save.
   (The Google *client secret* lives only inside Supabase — never in this repo.)

## 4. Tell Supabase where your app lives
Supabase -> *Authentication -> URL Configuration*:
- **Site URL:** `https://<your-github-username>.github.io/<repo-name>/`
- **Redirect URLs:** add the same URL (with the trailing slash). For local testing also add `http://localhost:3000/` (or the port you use).
  Finora redirects to the page **without** the `#/route` part, so no hash is needed.

## 5. Put the PUBLIC values in `js/config.js`
Supabase -> *Project Settings -> API*:
```js
export const SUPABASE_CONFIG = {
  url: 'https://<project-ref>.supabase.co',
  key: 'sb_publishable_...',      // the PUBLISHABLE key (or the legacy "anon" key)
};
```
**Never** paste the *secret* / *service_role* key. Finora refuses to start sync if it sees one — but if you ever committed one,
rotate it in the dashboard immediately.

Commit and push; GitHub Pages redeploys. (Run `npm run build:sw` first so the offline cache refreshes.)

## 6. Check it works
Open the deployed app -> **Settings -> Server sync (beta)**:
1. **Sign in with Google** -> you return to Settings, signed in.
2. Choose a **passphrase** (10+ characters). *Write it down* — if you forget it, data stored on the server cannot be recovered.
3. Press **Start live sync** (first device: "Start syncing this device's data").
4. **Second device:** open the app, sign in with the same Google account, enter the same passphrase, then choose
   **"Join existing data"** -> Start live sync. Its data appears; from then on changes show up on both within a second or two.

In *Table Editor -> sync_records* you will see rows with unreadable `payload` text (ciphertext). That is correct.
In *Table Editor -> sync_profiles* one row (salt + verifier only).

**Quick two-device test:** add an expense on the PC; watch the phone's topbar chip say *Live* and the expense appear without pressing anything.
If it doesn't: Supabase -> *Database -> Replication* (or the SQL editor) — confirm `sync_records` is in the `supabase_realtime`
publication (the schema script does this). Without Realtime Finora still syncs, just every minute instead of instantly.

**Free plan reminder:** a project with no activity for a week is paused (restore it from the dashboard — nothing is lost).

## Security notes (why this is safe to host publicly)
- The URL + publishable key are meant to be public. Protection = **Row Level Security** (each user can only read/write their own rows)
  + **end-to-end encryption** (the server stores ciphertext only; AES-256-GCM, key derived from your passphrase with PBKDF2-600k).
- Nobody can hard-delete rows through the API (no DELETE policy) — deletes are "tombstones", which also keeps Realtime from leaking deletions.
- The server can still see *metadata*: your account, how many records, record ids, sizes and timestamps — not amounts, names or notes.
