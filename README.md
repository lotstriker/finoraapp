# Finora

A private, offline-first personal finance app — accounts, income, expenses,
transfers, people (lending/borrowing), loans & EMI, Bid & Save committees,
savings goals, and recurring reminders. Built as locked-spec vanilla
HTML/CSS/JS with IndexedDB as the only data store — nothing leaves your
device, no backend, no account required.

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

- **Loan EMIs are flat** — no principal/interest breakdown per installment.
  The schedule and ledger shape support adding real amortization later
  without any breaking changes.
- **No charting library** — Reports uses lists, percentages, and a simple
  progress bar rather than a charts dependency, per the spec's own
  "don't sacrifice correctness/clarity to add charts" guidance. A chart
  library can be layered on top of the existing report data later.
- **Single currency (INR)** — no multi-currency support.
- **One device, no sync** — this is intentional (see Architecture &
  Technology doc); Backup/Restore is the way to move data between devices.

## Backup & Restore

Settings → Backup & Restore. Backups are encrypted client-side with
AES-256-GCM (key derived via PBKDF2, 250,000 iterations) using the browser's
native Web Crypto API — the password never leaves your device, and Finora
cannot recover a lost backup password for you. Restore supports **Merge**
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
