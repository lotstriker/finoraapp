# Finora — Fixes Applied

Test status: **27/27 pass** (`npm test`). Har bug ka ek regression test hai.
Saari files import-resolve hoti hain (smoke check).

| # | Problem | Fix | File(s) | Test |
|---|---|---|---|---|
| 1 | Reversal/refund ke baad Reports, Dashboard, Budgets, Insights mein expense/income **double** | Naya `utils/ledger-math.js` (`signedExpense`, `signedIncome`, `liveExpenses`); sab totals ab reversal/refund-aware | `dashboard.js`, `reports-page.js`, `budgets.js`, `insights.js` | reversed expense/income, budget refund |
| 2 | Credit card overpayment mein paisa gayab | Overpay ab **credit balance** banta hai (`usedAmount < 0`), clamp hata diya; UI "credit balance (overpaid)" dikhata hai | `ledger.js`, `accounts-page.js` | CC overpay conserved |
| 3 | Ek transaction do baar reverse ho sakta tha | Guard ab **transaction ke andar** (`assertNotAlreadyReversed`), dono paths (normal + linked) | `ledger.js` | concurrent double reverse |
| 4 | Double-click = double EMI / redeem / scheduled / committee cycle | (a) status check transaction ke andar, (b) **har modal button async handler ke dauran auto-disable** | `loans.js`, `investments.js`, `scheduled.js`, `committees.js`, `modal.js` | 4 concurrency tests |
| 5 | Merge restore: ID collision pe row drop, counter sync nahi, categories duplicate, balances galat | Collision pe incoming row ko **naya id + saare references remap**; counter sync; categories/budgets name se dedupe; **balances ledger se recompute**; device-unique ids (`TXN-2026-000001-k3x9`); `deviceId` restore mein overwrite nahi hota | `backup.js`, `ids.js` | 6 merge/replace tests |
| 6 | Savings: contribute→withdraw→reverse se paisa paida | Reverse block jab goal ke paas utna nahi bacha; withdraw check bhi tx ke andar | `savings.js` | savings tests |
| 7 | Bill split / investment non-atomic (beech mein fail = orphan rows) | Poora flow **ek atomic transaction**; reverse bhi | `bill-splits.js`, `investments.js`, `scheduled.js` | bill split rollback |
| 8 | Raat 12–5:30 AM IST pe date ek din peeche | `todayLocal()` + `dateInputToIso()` (aaj = abhi ka time, baaki din = local noon) — 10 pages | `utils/date.js` + pages | date test |
| 9 | Koi automated test nahi | `tests/` (node:test + fake-indexeddb) | `tests/*.mjs`, `package.json` | — |
| 10 | PBKDF2 250k | **600k** (OWASP); decrypt backup ke andar likhe iteration count se hota hai, isliye purane backups khulte rahenge | `backup.js`, `google-drive-backup.js` | crypto test |
| 11 | `CLIENT_ID` placeholder "configured" maana jata tha | Config check ab sirf real-shape ID (`...apps.googleusercontent.com`) accept karta hai. **Apni Client ID `google-auth.js` mein paste karo** | `google-auth.js` | google test |

## Behaviour changes jo tumhe pata hone chahiye
- **Naye ledger IDs** ka format `TXN-2026-000042-k3x9`. Purane IDs bilkul valid hain.
- **Credit card** pe overpay allowed hai (credit balance). Pehle clamp hota tha.
- **Savings reverse** ab block ho sakta hai ("pehle later withdrawal reverse karo") — yeh jaan-boojh ke hai.
- **Merge restore** ke baad accounts/people/goals ke balances ledger se dobara calculate hote hain.
- Merge ki limit: agar *same record* (jaise ek loan installment) dono devices pe alag badla ho, to local copy jeetti hai. Ek device ko doosre ka exact copy banana ho to **Replace** use karo.

---

# Round 2 — security, data-safety, UI quick wins
Test status: **35/35 pass** (`npm test`) · contrast audit: **0 of 261** pairs below 4.5:1 (was 58 of 243).

| # | Problem | Fix | File(s) |
|---|---|---|---|
| 12 | Hostile account/person/goal **names** could inject HTML via modal titles, confirm dialogs, toasts | Modal title, confirm message and toast text are now **plain text** (`textContent`); remaining raw interpolations escaped (settings option lists, categories, **CSV-import preview**, recurring prompt); 4 callers that pre-escaped titles un-escaped to avoid `&amp;` | `modal.js`, `toast.js`, `settings-page.js`, `recurring-page.js`, `investments-page.js`, `bill-splits-page.js`, `scheduled-page.js` |
| 13 | No CSP | `Content-Security-Policy` meta: only own files, Google Fonts, Google sign-in + Drive allowed; inline scripts / `onerror=` blocked | `index.html` |
| 14 | CSV export formula injection | Text cells starting `= + - @ tab CR` get a leading tab (OWASP); numbers untouched | `backup.js` |
| 15 | CSV import failed on Indian `dd/mm/yyyy`; re-importing a statement doubled everything | `parseImportDate` (dd/mm/yyyy, dd-mm-yy, dd.mm.yyyy, yyyy-mm-dd; rejects 31/02); **duplicate detection** (skipped by default, checkbox to override) | `csv-import.js`, `settings-page.js` |
| 16 | IndexedDB is best-effort storage; could be evicted | `navigator.storage.persist()` at startup | `app.js` |
| 17 | Another tab blocked DB upgrades | `onversionchange` closes the stale connection | `db.js` |
| 18 | Modal: no focus management | Focus moves in, **Tab trapped**, focus returns to opener, `aria-labelledby` | `modal.js` |
| 19 | Toasts invisible to screen readers | `role="alert"` (error/warning) / `role="status"` (rest) | `toast.js` |
| 20 | **Contrast** failed WCAG AA in all 8 themes | Auto-tuned `text-faint/muted`, status colours, sidebar text per theme; new `--color-on-primary` (white or near-black, whichever passes on primary **and** hover) used by buttons | `variables.css`, `components.css`, `layout.css` |
| 21 | Mobile menu opened as unlabeled icon rail | Open sidebar now 260px with labels + bigger touch targets | `layout.css` |
| 22 | 16px dead gap beside sidebar (grid 76/240 vs sidebar 60/224) | Grid columns match the real widths (flush) | `layout.css` |
| 23 | Topbar transparent: content scrolled through its title | Semi-opaque + blur background | `layout.css` |

## Behaviour changes
- **CSP is new** — I could not run it in a real browser. If something external stops working (fonts, Google sign-in), open DevTools -> Console: the blocked origin is named. Add it to the `<meta>` in `index.html`.
- **Theme colours shifted slightly**: faint/muted text is a bit stronger; some neon themes get dark button labels instead of white.
- CSV import now **skips likely duplicates** unless you tick the checkbox.

---

# Round 3 — logic fixes + quick-add
Test status: **51/51 pass** (`npm test`).

| # | Problem | Fix | File(s) |
|---|---|---|---|
| 24 | Recurring monthly rule drifted for ever (31 Jan -> 28 Feb -> 28 Mar ...) | Rule stores its `anchorDay`; month steps use `min(anchorDay, days in month)` -> 31 Jan, 28 Feb, **31 Mar**, 30 Apr. Previous-date (undo) is the exact inverse | `utils/date.js`, `recurring.js` |
| 25 | Paying a recurring bill late/early shifted the schedule | Calendar rules advance from the **due date**; validity rules ("28-day recharge") still restart from the payment day | `recurring.js` |
| 26 | Debt planner: freed EMIs did not roll into the next loan, so "months/interest saved" was understated (old code said **0 months saved** where the true answer is 2) | Real snowball/avalanche: budget = all minimums + extra; leftover and freed minimums go to the priority loan and **cascade mid-month**. Loans whose minimum never covers interest are flagged instead of showing "0 months" | `debt-planner.js`, `loans-page.js` |
| 27 | Net worth subtracted **future interest** as if it were already owed | New `loanProgress().remainingPrincipal`; dashboard and the net-worth history chart subtract principal only. (The Loans card still shows total left to pay) | `loans.js`, `dashboard.js`, `insights.js` |
| 28 | Adding an entry took 3 steps (sidebar -> page -> Add) | Topbar **+ Add** menu on every page: Expense / Income / Transfer (hides modules you switched off). Deep link `#/expenses?add=1` opens the Add modal; URL is cleaned so refresh doesn't reopen it | `app.js`, `layout.css`, 3 pages, `dom.js` |
| 29 | Transfers "Add" button passed the click event as `preselectFromId` | Called without arguments | `transfers-page.js` |

## Behaviour changes
- **Existing recurring rules** have no `anchorDay`; they use the day of their current due date. A rule that already drifted to the 28th stays on the 28th until you recreate it with the right start date.
- **Net worth will go UP** on dashboards with interest-bearing loans (that is the correction).
- Debt planner now shows bigger savings numbers (correct ones).
- The quick-add menu and layout were verified in jsdom, not a real browser: check the "+ Add" dropdown on your phone.

---

# Round 4 — the rest: Google Drive, offline/PWA, UX, performance
Test status: **87/87 pass** (incl. a full-app boot test in jsdom) (`npm test`).

## Google Drive (my design decisions)
| # | Problem | Fix |
|---|---|---|
| 30 | Two profiles overwrote each other's cloud backup | Each profile's data has a random **datasetId**; cloud file = `finora-dataset-<id>.json`. Restoring adopts the id, so phone and PC keep syncing to the same file |
| 31 | "Last write wins" — a second device erased the first one's backup | **Optimistic concurrency**: Backup refuses if the cloud copy changed since this device last synced and offers *Merge first / Overwrite cloud / Cancel* |
| 32 | Backups > 5 MB failed (multipart limit) | Resumable upload above 4 MB |
| 33 | Half-granted consent (Drive box unticked) looked "connected" then failed with 403 | `hasGrantedAllScopes` check + clear message |
| 34 | Silent reconnect could open a blocked popup; token expiry (1 h) caused confusing 401s | `prompt:'none'` for background reconnect; expiry tracked; one automatic refresh+retry on 401 from a user click; friendly 403/404/429/5xx messages |
| 35 | Restore had no way to choose between several cloud backups | Picker (profile name + date); old-format files still listed |
| 36 | Device-local keys (deviceId / cloudSync) could travel inside backups | Excluded from export, preserved on Replace |

## Offline / install
| 37 | Not installable, no offline shell | `manifest.webmanifest` (+192/512/maskable icons, shortcuts), `sw.js` with generated `precache.js`, network-first caching, never touches Google requests; "Finora was updated" toast |
| 38 | Notifications broke on Android Chrome (`new Notification` is illegal there) | Service-worker `showNotification` with constructor fallback; failed ones are retried (not marked as sent); log pruned after 14 days |

## UX / accessibility / performance
| 39 | Errors were corner toasts that vanish | Errors now appear **inside the open dialog** next to the button (`role="alert"`) |
| 40 | No mobile thumb navigation | **Bottom nav** (Home, History, Accounts, Reports, More) |
| 41 | Dashboard was a wall of cards | **Net-worth hero + 6-month sparkline** (loaded after first paint) and **Budget Health** bars (with % as text) |
| 42 | Charts relied on red/green | Colour-blind-safe palette, hatched second series, "View as table" under each chart |
| 43 | Tabs weren't real tabs | `enhanceTabs`: roles, aria-selected, arrow/Home/End keys (Reports, Account detail) |
| 44 | Dashboard / recent list scanned the whole ledger | `getRecentTransactions` (date-index cursor) and `getLedgerBetween` (index range) |
| 45 | CSV export only transactions, UTC dates | + Accounts, Loan schedules, People, Savings goals; dates in local time |
| 46 | Negative balance only showed as a small badge | Immediate warning toast (`finora:insufficient-balance`) |
| 47 | Archiving an account/goal that still holds money gave no hint | Confirmation mentions the amount |
| 48 | Disabled-module route rendered twice; nav lost its highlight with `?query`; DB "blocked" failed instantly; error classes had no `name` | All fixed |
| 49 | Committees ignored foreman commission (registered chit funds) | Optional **commission %** (default 0 = unchanged); deducted from the bid before the dividend; bid below commission rejected. Check your own chit agreement |
| 50 | README out of date | Rewritten sections: honest Drive/encryption limits, PWA, CSP, amortization |

## Behaviour changes
- First Drive backup after upgrading creates a **new** file (`finora-dataset-…`); your old `finora-google-backup.json` stays as "Older-format backup" in the picker.
- **Run `npm run build:sw` after editing any app file** (a test reminds you), otherwise users keep the old cached code for a visit.
- Optional modules still start OFF (so the topbar "+ Add" hides Expense/Income until enabled in Settings).
- Not testable here: Google sign-in/Drive against the real Google, the service worker in a real browser, and phone layouts. Everything else runs in tests (fake Google server, fake SW environment, jsdom).

---

# Round 5 — Automatic Google Drive sync (A: auto-backup + B: check cloud on open)
Test status: **120/120 pass** (`npm test`; a fake Google server covers sign-in, Drive, versions, rate limits, offline, races).

## What was added
| Feature | How it behaves |
|---|---|
| **A. Auto-backup** | Every committed data change is detected (`onDataChanged` in `db.js`). ~30 s after the last change (max 3 min of continuous edits) it saves to Drive. On app-hidden/pagehide it flushes at once. Unchanged data is never re-uploaded (SHA-256 content hash). A persisted "unsaved" marker survives closing the app. |
| **B. Check cloud** | On open (1.5 s after first paint), on returning to the app (if last check > 2 min), on coming back online, and every 5 min while visible. Cloud newer + this device clean → **automatic safe update** (screen refreshes + toast). Cloud newer + local unsaved changes → **Conflict** (Merge first / Overwrite / Cancel). |
| New-device safety | Existing backups but none for this profile → asks **Restore one / Start separate backup**; never forks silently. |
| Status chip | Topbar chip with TEXT states (Synced, Saving soon, Syncing…, Offline, Reconnect, Conflict, Update ready, Choose backup, Sync issue); click = the right action. |
| Settings | "Automatic sync" switch (per device), live status line, **Sync now**. |
| Safety | Dialog open → update is deferred, not forced. Edit during a download → becomes Conflict (never erased). Other tab already syncing → skipped (Web Locks). Needs-user states don't retry in the background. |

## Cross-check against the official docs — mistakes in my EARLIER code that are now fixed
1. **`appProperties` limit is 124 BYTES (key+value, UTF-8)** — I had cut `profileName` at 60 *characters*; a Hindi/emoji name would have made Drive reject (400) every backup. Now cut by bytes (tested with Hindi + emoji).
2. **All 403s were treated as "permission"** — Drive docs: `userRateLimitExceeded`/`rateLimitExceeded` (403) and `429` are rate limits (retry with exponential backoff + jitter); only other 403s are permission problems. Errors are now classified (`DriveError.kind`).
3. **Conflict detection used a modified-time string** — docs: file `version` is monotonically increasing. Now uses `version` (falls back to modifiedTime for older sync records).
4. **Token model:** docs say a new token needs a **user gesture** after expiry → background sync never opens popups; added `login_hint` (skips account selection) and the one-tap Reconnect.
5. **Content hash was never stable** (the backup itself wrote `lastBackupAt` into the exported data) — found by a test; bookkeeping keys are excluded from the hash.
6. Verified correct: `prompt:''/'none'/'consent'` values, `hasGrantedAllScopes` signature, `error_callback` types, resumable flow (`PATCH` for updates — `PUT` gives no `Location`), `X-Upload-Content-*` headers, `appDataFolder` scope.

## Behaviour changes
- Existing connected users: automatic sync defaults to **ON**; the first cycle may show *Choose backup* if only older-format files exist.
- Device-local keys (never in backups, never overwritten by restore): `deviceId`, `cloudSync`, `autoSync`, `cloudDirty`, `cloudStartFresh`.
- A manual `.finora` file restore now counts as a change (so it reaches the cloud).
- **Run `npm run build:sw` after editing app files** (tests remind you).

## Honest limits (not bugs)
- **Not real-time.** Another device's change appears when this device next checks (open / foreground / ≤5 min while open).
- **Google's token model**: after ~1 hour the chip may ask for one tap ("Reconnect"). Truly unattended sync needs a server.
- Merge keeps the local copy when the *same record* changed on both devices.
- Tested with a fake Google in Node/jsdom — please run one real round on two devices before relying on it.

---

# Round 6 — Live sync with Supabase (end-to-end encrypted)
Test status: **194/194 pass.** The server schema is tested on a **real Postgres** (PGlite) and the sync engine runs against it with two simulated devices; the real vendored supabase-js was checked for PKCE. Not yet run against a real Supabase project / real Google — see "What I could NOT verify".

## What was added
| Piece | Notes |
|---|---|
| `supabase/schema.sql` | Tables `sync_profiles`, `sync_records`; RLS (own rows only); **no DELETE policy** (tombstones); trigger-assigned `seq`/`rev`/`updated_at`; `sync_push()` atomic batch with optimistic concurrency; `sync_list_datasets()`; Realtime publication. 12 SQL tests on real Postgres |
| Login | Supabase Auth + Google, **PKCE** (verified with the real library: implicit flow would put tokens in the `#hash` and break the hash router). `?code=` is exchanged then removed, `#route` kept. Secret/service_role keys are **refused** |
| Encryption | AES-256-GCM, PBKDF2-600k, AAD = dataset\|store\|id (a server can't swap ciphertexts); non-extractable key kept per device; wrong passphrase rejected via a stored verifier |
| Engine | Hash-based change detection, pull-then-push, cursor paging with overlap, tombstones, conflict log (your overwritten copy is kept), derived balances recomputed, name-keyed categories/budgets, settings sync (device-local keys excluded), deterministic legacy-ledger-id migration |
| Scheduler | Debounced push, Realtime hint → pull, poll fallback, offline backoff, one-tab-at-a-time lock, never syncs while a dialog is open |
| UI | Settings "Server sync (beta)": sign in → passphrase → **start / join** → status, conflicts list, stop. Topbar chip shows **Live** (server) or the Drive status |
| Vendored lib | `js/vendor/supabase-js-2.117.2.umd.js` (MIT), loaded only when used; CSP allows `*.supabase.co` + `wss:` |

## Bugs the tests caught while building this
1. **Infinite sync loop** — each pull re-reads 50 old rows (overlap) and opened a write transaction even when all were already known; that looked like "the user edited something" and re-triggered sync every ~70 ms. Fixed (only apply new rows; engine writes are flagged and ignored by the scheduler) + regression tests.
2. **Fake conflicts on every new device** — default categories seeded per device differ in `createdAt`; now ignored for name-keyed records.
3. **`event.currentTarget` is null after an await** — error paths crashed in the new buttons (browser behaves the same). Captured before awaiting.
4. **Danger found by design review:** "Delete all data" / Replace-restore would have been read as "user deleted everything" and pushed tombstones wiping every other device. Bookkeeping now resets in both.

## What I could NOT verify (please test on real devices)
- A real Supabase project: Google provider setup, Realtime delivery, the real PostgREST behaviour of `rpc()`/`select()`. (Logic is verified against real Postgres, but not through Supabase's HTTP layer.)
- Two real browsers/phones running at once, and the free-plan pause/restore.
- Performance with very large ledgers (tested 1,100 rows).

## Behaviour notes
- First sync **merges**; if two devices each created the same account separately you may see it twice (archive one).
- Starting live sync switches Drive auto-backup off.
- Passphrase change/reset, tombstone clean-up and a free-plan keep-alive are not built yet (Phase 4).

## Still not done
- Real end-to-end encryption for Drive (needs a user passphrase; the key is derived from the Google account id, which is not secret)
- Per-field inline form validation · virtualised long lists · multi-currency
