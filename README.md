# Finora

A private, offline-first personal finance app — accounts, income, expenses,
transfers, people (lending/borrowing), loans & EMI, Bid & Save committees,
savings goals, and recurring reminders. Built as locked-spec vanilla
HTML/CSS/JS with IndexedDB as the only data store — no backend, no account
required, and your data stays on your device **unless you switch on Google
Drive backup** (see "Backup & Restore" for exactly what is sent). Installable
as an app (PWA) and works offline after the first visit.

## Running it

Browsers block ES module `import` statements over `file://` (CORS), so open
`index.html` through a local server rather than double-clicking it:

```bash
npx serve .
# or use VS Code's "Live Server" extension
```

Then open the printed `http://localhost:...` URL. On first launch you'll get
a short setup wizard (currency confirmation, an optional Main Account, and a
choice of which optional modules you want visible).

## Project structure

```
finora/
├── index.html              Entry point — loads fonts, CSS, then js/app.js
├── css/
│   ├── variables.css        Design tokens (colors, spacing, light/dark/system theme)
│   ├── base.css              Reset + typography
│   ├── layout.css            Sidebar/topbar app shell, responsive rules
│   └── components.css        Buttons, cards, lists, modal, toast, progress bar
└── js/
    ├── app.js                 Bootstrap: theme, sidebar nav, hash router, onboarding
    ├── core/
    │   ├── db.js               IndexedDB schema + generic transaction helpers
    │   ├── ledger.js           The Master Ledger — the ONLY place balances change
    │   ├── ids.js               Ledger transaction ID generator (TXN-YYYY-NNNNNN)
    │   ├── modal.js             Reusable modal + confirm dialog
    │   └── toast.js             Toast notifications
    ├── modules/                One file per domain — all business logic lives here
    │   ├── accounts.js, categories.js, income.js, expenses.js, transfers.js
    │   ├── people.js, loans.js, committees.js, savings.js, recurring.js
    │   ├── backup.js            Encrypted backup/restore + CSV export
    │   └── preferences.js       Settings key/value store, module enable/disable
    ├── pages/                   One render function per screen, wired in app.js
    └── utils/                   currency.js, theme.js, dom.js, icons.js
```

## Architecture in one paragraph

Every module function that moves money calls `core/ledger.js#createTransaction()`,
which is the single place that (a) generates the ledger ID, (b) applies the
balance effect to the right account(s)/person, and (c) writes the ledger
record — all inside **one atomic IndexedDB transaction**, so a crash mid-write
can never leave a mismatched balance. Modules that need extra state kept in
sync with a ledger write (marking a loan installment paid, updating a
committee cycle, moving a savings goal's balance) pass an `extraStores` +
`sideEffect` option into `createTransaction()`, which runs inside that same
atomic transaction rather than as a separate, riskier follow-up write.

## Locked decisions this build follows

These came out of an audit of the original 26-file spec before Phase 1 began:

- **People are not Accounts.** A person is linked to the ledger via `personId`
  only, never `accountId` (see `modules/people.js`).
- **Initial Balance is never silent.** Entering one at account-creation time
  fires a real `external_funding` ledger transaction.
- **Credit Cards** track `creditLimit` + `usedAmount` as real fields; going
  over the limit is a hard block, not a warning.
- **Savings goals never share a pool** — each goal has its own `currentAmount`.
- **Corrections** use either a linked reversal transaction
  (`parentTransactionId`) or a limited edit to description/tags only — amount,
  date, account, and type are immutable once posted.
- **Recurring rules only remind** — Finora never posts a transaction on its
  own; "Record Payment" is always an explicit click.

## Known simplifications (by design, not oversights)

- **Loan EMIs use real reducing-balance amortization** — each installment
  stores its principal and interest part; the last EMI clears the exact
  balance. Net worth subtracts only the remaining *principal* (future interest
  is not owed yet).
- **No charting library** — charts are small hand-written SVGs. They use a
  colour-blind-safe palette, hatching (not colour alone) and a "View as table"
  twin so every number is readable by screen readers too.
- **Single currency (INR)** — no multi-currency support.
- **No live sync** — devices share data through Backup/Restore (file or Google
  Drive). Drive backup detects when another device changed the cloud copy and
  asks before overwriting it; Merge is for additive data, Replace makes a
  device an exact copy.

## Backup & Restore

Settings → Backup & Restore. Backups are encrypted client-side with
AES-256-GCM (key derived via PBKDF2-HMAC-SHA256, 600,000 iterations — the
OWASP recommendation; older 250,000-iteration backups still open) using the
browser's native Web Crypto API — the password never leaves your device, and
Finora cannot recover a lost backup password for you. Restore supports **Merge**
(keep existing data, add anything new) or **Replace** (clear everything
first). CSV export (Settings → Export) is separate, unencrypted, and meant
for spreadsheets — not a substitute for a real backup.

## Extending it

- New optional modules should follow the existing module file shape:
  validate → build a ledger `input` object → call `createTransaction()`
  (with `extraStores`/`sideEffect` if module-specific state needs to stay in
  sync) → return the result.
- New pages register in `js/app.js`'s `NAV` array (for the sidebar) and
  `PAGES` map (for the router) — see any existing entry for the pattern.


---

## Development

```bash
npm install        # installs fake-indexeddb (dev only)
npm test           # 194 regression tests: ledger, modules, backup/restore, Google Drive (fake server), PWA/service worker, security, planner, recurring, dashboard
```

Google Drive backup: paste your OAuth **Web client ID** into `CLIENT_ID` in
`js/modules/google-auth.js` (it must look like `123-abc.apps.googleusercontent.com`;
the "Connect Google" button stays hidden until it does).

Ledger ids look like `TXN-2026-000042-k3x9` — the last part is a per-device id
so merging backups from two devices cannot collide (old ids without it still work).

### Google Drive backup & automatic sync

**What it is:** copy + merge with safety checks. It is *not* real-time sync (that needs a server).

**Automatic sync (per device, Settings → Google Drive → "Automatic sync", default ON once connected)**
- **Auto-backup:** ~30 s after your last change (and at least every 3 min while you keep editing) Finora saves to Drive.
  When you switch app / lock the phone it tries to save immediately; if the browser freezes the page first, the
  "unsaved" marker is kept and the next open finishes the job. Identical data is never uploaded twice.
- **Check the cloud:** when Finora opens, returns to the foreground, comes back online, and every 5 min while visible.
  If *another device* saved newer data and **this device has no unsaved changes**, it is updated automatically
  (exact copy — nothing can be lost). If both changed, you are asked: **Merge first / Overwrite cloud / Cancel**.
- A new device that finds existing backups **asks** (restore one, or start a separate backup) — it never silently
  creates a second copy of your data.
- Status is always visible in the topbar chip (Synced · Saving soon · Syncing · Offline · Reconnect · Conflict · …).

**Google's rules this follows (official docs)**
- *Identity Services token model:* a new access token needs a **user gesture** once the old one expires (~1 hour).
  Background sync therefore only tries a silent refresh (`prompt:'none'`, no popup). If Google can't answer, the chip
  shows **Reconnect** — one tap. True unattended sync would need a server-side refresh token (out of scope: no backend).
- *Drive API:* `403 userRateLimitExceeded/rateLimitExceeded`, `429`, `5xx` → truncated exponential backoff with jitter;
  other `403` → permission problem (no blind retries). Custom file properties are limited to **124 bytes** (UTF-8) —
  profile names are cut by bytes, so Hindi/emoji names work. Updates use the file's monotonic **`version`**.
  Uploads > 4 MB use the resumable protocol (`PATCH` to update).
- *Page Visibility API:* `hidden` is the last reliable event → flush then (plus `pagehide` for older iOS Safari).
- *Web Locks API:* if another tab is already syncing, this tab skips (HTTPS/localhost only; otherwise per-tab guard).

**Files:** one per profile's data — `finora-dataset-<id>.json` in your Google account's private **App Data** folder
(only Finora can see it). A phone that restores the PC's backup adopts the same id and syncs to the same file.

**Limits you should know**
- Merge is for *additive* data (new transactions/accounts/people). If the **same record** (e.g. one loan installment)
  was changed on both devices, the local copy wins. Use **Replace** to make a device an exact copy of the cloud.
- The encryption key is derived from your Google account id, which is **not a secret**. It keeps the file unreadable to
  other Google accounts and apps, but anyone who can sign in as you (or Google itself) can read it. For real
  end-to-end protection use the password-protected `.finora` file backup.
- Needs internet. Closed-app/background sync is not possible for a web app without a server.

## Live server sync (Supabase) — optional, end-to-end encrypted

Frontend stays on GitHub Pages; **your own Supabase project** is the sync hub. Setup (15 min): `supabase/SETUP.md`.

- **Live:** an edit is sent ~2 s after you stop typing; other open devices are told by Supabase Realtime and pull within
  ~0.5 s. If Realtime is unavailable it falls back to polling every minute. Offline edits are kept and sent when you are back.
- **Private:** records are encrypted on your device (AES-256-GCM, key from your passphrase via PBKDF2-600k) *before* upload,
  bound to their record id (AAD). The server stores ciphertext + metadata only. **Lost passphrase = lost server copy.**
- **Safe:** Row Level Security per user; no hard deletes (tombstones); atomic batch push with per-record revisions;
  your own device never overwrites silently — when the same item changed on two devices, the newer server version wins and
  **your overwritten copy is kept** in Settings → "Edits that were replaced".
- **Balances aren't synced** (devices would fight over them): they are recomputed from the ledger after each pull.
- **Wiping one device** ("Delete all data" or a Replace-restore) does *not* delete anything on your other devices.
- Starting live sync turns the Google Drive auto-backup off (manual backups still work); keep a backup anyway.

**Limits:** free Supabase projects pause after a week of inactivity (restore from the dashboard); same-record conflicts keep
the newer server version; the server can see *metadata* (record ids, counts, sizes, times) but not amounts or names;
a changed passphrase is not supported yet (planned).

## Offline & install

`sw.js` precaches the whole app (list generated into `precache.js`) and serves
files network-first, so you always get the newest code online and the cached
copy offline. **After changing any file run `npm run build:sw`** (the test
suite fails if `precache.js` is stale). Notifications use the service worker
(`showNotification`), which is the only way Android Chrome allows them; they
still only fire while Finora is open.

## Content-Security-Policy

`index.html` ships a strict CSP (own files, Google Fonts, Google sign-in and
Drive only). If you add another external service, add its origin there.
