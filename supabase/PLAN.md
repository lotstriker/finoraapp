# Finora server sync — plan & status

Goal: live (1–2 s) sync between devices for the owner, keeping Finora offline-first, with **end-to-end encryption**
so the server can't read finances. Frontend stays on GitHub Pages; Supabase is the sync hub.

## Architecture (decided from the official docs)
| Topic | Decision | Why (docs) |
|---|---|---|
| Login | Supabase Auth, Google provider, **PKCE** | Implicit flow puts tokens in the URL `#hash`, which collides with our hash router. PKCE returns `?code=` |
| Data | One row per record: `sync_records(user, dataset, store, record_id, rev, seq, deleted, payload)` | Per-record sync = small, incremental |
| Encryption | AES-256-GCM, key from passphrase (PBKDF2-600k), AAD = dataset\|store\|id | Server sees ciphertext only; AAD stops record-swapping |
| Deletes | **Tombstones** (UPDATE `deleted=true`), no DELETE policy | Realtime docs: RLS is *not* applied to DELETE events |
| Concurrency | `sync_push()` RPC: atomic batch, per-record `base_rev` check | One round trip, no half-applied batches |
| Cursor | Server-assigned increasing `seq`; clients pull `seq > N` in pages of ≤ 500 | PostgREST returns ≤ 1000 rows per request |
| Realtime | Postgres Changes used only as a **hint** ("pull now") | Never trust events for correctness (missed events on reconnect) |
| Offline | IndexedDB stays the source of truth; queue + diff, push when online | Existing architecture |
| Derived data | Do **not** sync balances; recompute from the ledger after pull (`recomputeBalancesInTx`) | Prevents two devices fighting over `account.balance` |
| Ledger ids | Device-unique already (`TXN-2026-000042-k3x9`); legacy ids get a deterministic content-hash suffix before first push | Prevents duplicates/collisions across devices |
| Free plan | Project pauses after 1 week inactive | Pricing page; Finora must degrade gracefully (offline) |

## Phases
| # | What | Status |
|---|---|---|
| 1 | SQL schema + RLS (tested on real Postgres), vendored supabase-js, PKCE sign-in, E2E crypto, passphrase setup UI | **Done** |
| 2 | Sync engine: change detection (record hashes), push via `sync_push`, pull by `seq`, apply + recompute balances, tombstones, conflict log, legacy-id migration | **Done** (tested on real Postgres, two simulated devices) |
| 3 | Scheduler (debounce, Realtime hint, poll fallback, offline backoff, busy-dialog guard), topbar chip, Settings: start / join / stop, conflict list | **Done** |
| 4 | Passphrase change / reset, tombstone clean-up, optional keep-alive for the free plan, real-device verification | Next |

## Honest limits
- Not a replacement for backups: keep the Drive/`.finora` backups too.
- Lost passphrase = lost *server* copy (by design).
- Same-record conflicts: the newer server version wins and your overwritten copy is logged (Phase 2) — not silently dropped.
- Free plan: pauses after a week of no use; 500 MB DB; 5 GB egress (see supabase.com/pricing).
