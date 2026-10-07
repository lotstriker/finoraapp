// Runs supabase/schema.sql against a REAL Postgres (PGlite = Postgres compiled to WASM) with a small stub of
// Supabase's `auth` schema, so RLS, the trigger and sync_push() are verified for real — not just reasoned about.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const SCHEMA = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
let db;

/** Run as a signed-in Supabase user (role `authenticated`, auth.uid() = id). */
async function as(userId, fn) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${userId}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
const push = (user, dataset, items, device = 'dev1') =>
  as(user, async () => (await db.query('select public.sync_push($1,$2,$3::jsonb) as r', [dataset, device, JSON.stringify(items)])).rows[0].r);
const item = (store, record_id, payload, extra = {}) => ({ store, record_id, base_rev: 0, deleted: false, payload, ...extra });

before(async () => {
  db = new PGlite();
  // --- minimal stub of what Supabase provides ---
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
    grant usage on schema public to authenticated, anon;
    create publication supabase_realtime;
    insert into auth.users values ('${U1}'), ('${U2}');
  `);
  await db.exec(SCHEMA);
});

test('schema runs, and is safe to run a second time', async () => {
  await db.exec(SCHEMA);                                   // idempotent
  const t = (await db.query(`select tablename from pg_tables where schemaname='public' order by 1`)).rows.map((r) => r.tablename);
  assert.deepEqual(t, ['sync_profiles', 'sync_records']);
  const pub = (await db.query(`select tablename from pg_publication_tables where pubname='supabase_realtime'`)).rows;
  assert.deepEqual(pub.map((r) => r.tablename), ['sync_records']);
});

test('RLS is enabled and anonymous visitors can do nothing', async () => {
  const rls = (await db.query(`select relname, relrowsecurity from pg_class where relname in ('sync_records','sync_profiles') order by 1`)).rows;
  assert.ok(rls.every((r) => r.relrowsecurity));
  await db.exec(`set role anon`);
  await assert.rejects(() => db.query('select * from public.sync_records'), /permission denied/);
  await assert.rejects(() => db.query(`select public.sync_push('d','x','[]'::jsonb)`), /permission denied/);
  await db.exec('reset role');
});

test('push: new record -> rev 1 with a server seq; payload stored verbatim', async () => {
  const r = await push(U1, 'ds1', [item('ledger', 'TXN-1', 'CIPHER-A'), item('accounts', 'acc_1', 'CIPHER-B')]);
  assert.deepEqual(r.map((x) => x.status), ['ok', 'ok']);
  assert.deepEqual(r.map((x) => x.rev), [1, 1]);
  assert.ok(r[1].seq > r[0].seq, 'seq increases');
  const row = (await db.query(`select payload, user_id, device_id from public.sync_records where record_id='TXN-1'`)).rows[0];
  assert.equal(row.payload, 'CIPHER-A'); assert.equal(row.user_id, U1); assert.equal(row.device_id, 'dev1');
});

test('push: update with the right base_rev bumps rev and seq; stale base_rev is a CONFLICT and writes nothing', async () => {
  const [a] = await push(U1, 'ds1', [item('accounts', 'acc_2', 'v1')]);
  const [b] = await push(U1, 'ds1', [item('accounts', 'acc_2', 'v2', { base_rev: a.rev })]);
  assert.equal(b.status, 'ok'); assert.equal(b.rev, 2); assert.ok(b.seq > a.seq);
  const [c] = await push(U1, 'ds1', [item('accounts', 'acc_2', 'v3-from-stale-device', { base_rev: a.rev })], 'dev2');
  assert.equal(c.status, 'conflict'); assert.equal(c.rev, 2);
  const row = (await db.query(`select payload, rev from public.sync_records where record_id='acc_2'`)).rows[0];
  assert.equal(row.payload, 'v2', 'the stale write changed nothing'); assert.equal(row.rev, 2);
});

test('push: "new" (base_rev 0) on an id that already exists is a conflict, not an overwrite', async () => {
  await push(U1, 'ds1', [item('ledger', 'TXN-X', 'first')]);
  const [r] = await push(U1, 'ds1', [item('ledger', 'TXN-X', 'second')], 'dev2');
  assert.equal(r.status, 'conflict');
});

test('push batch is mixed-result and atomic per call: ok + conflict in one request', async () => {
  const [seed] = await push(U1, 'ds1', [item('people', 'p1', 'x')]);
  const r = await push(U1, 'ds1', [item('people', 'p2', 'new'), item('people', 'p1', 'stale', { base_rev: 99 })]);
  assert.deepEqual(r.map((x) => x.status), ['ok', 'conflict']);
});

test('soft delete: a tombstone is an UPDATE (so Realtime/RLS protect it); clients cannot hard-DELETE', async () => {
  const [a] = await push(U1, 'ds1', [item('bill_splits', 'bs1', 'x')]);
  const [b] = await push(U1, 'ds1', [item('bill_splits', 'bs1', 'x', { base_rev: a.rev, deleted: true })]);
  assert.equal(b.status, 'ok');
  const row = (await db.query(`select deleted from public.sync_records where record_id='bs1'`)).rows[0];
  assert.equal(row.deleted, true);
  await as(U1, async () => {
    await db.query(`delete from public.sync_records where record_id='bs1'`).catch(() => {});
    const left = (await db.query(`select count(*)::int as n from public.sync_records where record_id='bs1'`)).rows[0].n;
    assert.equal(left, 1, 'DELETE removed nothing (no delete policy)');
  });
});

test('RLS isolation: user 2 cannot see, update or collide with user 1 data', async () => {
  await push(U1, 'dsA', [item('ledger', 'secret-1', 'U1-CIPHER')]);
  await as(U2, async () => {
    const seen = (await db.query(`select count(*)::int as n from public.sync_records where record_id='secret-1'`)).rows[0].n;
    assert.equal(seen, 0);
  });
  // the same ids under user 2 are a completely separate row
  const [r] = await push(U2, 'dsA', [item('ledger', 'secret-1', 'U2-CIPHER')]);
  assert.equal(r.status, 'ok'); assert.equal(r.rev, 1);
  await as(U1, async () => {
    const mine = (await db.query(`select payload from public.sync_records where record_id='secret-1'`)).rows;
    assert.deepEqual(mine.map((x) => x.payload), ['U1-CIPHER']);
  });
  // forging user_id on a direct insert is rejected by the RLS check
  await as(U2, async () => {
    await assert.rejects(() => db.query(`insert into public.sync_records (user_id, dataset_id, store, record_id, payload, device_id) values ('${U1}','dsA','ledger','forged','x','d')`), /row-level security/);
  });
});

test('clients cannot forge seq / rev / updated_at (trigger overrides them)', async () => {
  await as(U1, async () => {
    await db.query(`insert into public.sync_records (dataset_id, store, record_id, payload, device_id, seq, rev, updated_at) values ('dsF','ledger','f1','x','d', 0, 999, '2001-01-01')`);
    const row = (await db.query(`select seq, rev, updated_at from public.sync_records where record_id='f1'`)).rows[0];
    assert.ok(Number(row.seq) > 0); assert.equal(Number(row.rev), 1); assert.ok(new Date(row.updated_at).getFullYear() >= 2026);
  });
});

test('pull: "everything after seq N" returns changes in order, scoped to one dataset', async () => {
  const r = await push(U1, 'dsP', [item('ledger', 'p-1', 'a'), item('ledger', 'p-2', 'b'), item('ledger', 'p-3', 'c')]);
  const cursor = r[0].seq;
  await push(U1, 'dsOther', [item('ledger', 'noise', 'zzz')]);
  await as(U1, async () => {
    const rows = (await db.query(`select record_id, seq from public.sync_records where dataset_id='dsP' and seq > $1 order by seq limit 500`, [cursor])).rows;
    assert.deepEqual(rows.map((x) => x.record_id), ['p-2', 'p-3']);
  });
});

test('sync_push guards: not signed in, oversized batch', async () => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','',false);`);
  await assert.rejects(() => db.query(`select public.sync_push('d','x','[]'::jsonb)`), /not signed in/);
  await db.exec('reset role');
  const big = Array.from({ length: 501 }, (_, i) => item('ledger', `b${i}`, 'x'));
  await assert.rejects(() => push(U1, 'dsBig', big), /at most 500/);
});

test('encryption profile: own row only; a second insert for the same user is refused', async () => {
  await as(U1, async () => {
    await db.query(`insert into public.sync_profiles (kdf_salt, verifier) values ('salt','ver')`);
    const mine = (await db.query(`select kdf_iterations from public.sync_profiles`)).rows;
    assert.equal(mine.length, 1); assert.equal(mine[0].kdf_iterations, 600000);
    await assert.rejects(() => db.query(`insert into public.sync_profiles (kdf_salt, verifier) values ('salt2','ver2')`), /duplicate key/);
    await assert.rejects(() => db.query(`update public.sync_profiles set verifier='tamper'`).then((r) => { if (r.affectedRows === 0) throw new Error('no rows updated (denied)'); }), /denied|permission/);
  });
  await as(U2, async () => {
    assert.equal((await db.query(`select * from public.sync_profiles`)).rows.length, 0, 'user 2 cannot see user 1 profile');
  });
});
