// A fake supabase-js client whose SERVER is the real schema.sql running on Postgres (PGlite).
// RLS, the seq/rev trigger and sync_push() are therefore the real thing; only the HTTP layer is faked.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const SCHEMA = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

export async function createServer(users = ['11111111-1111-1111-1111-111111111111']) {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
    grant usage on schema public to authenticated, anon;
    create publication supabase_realtime;
    ${users.map((u) => `insert into auth.users values ('${u}');`).join('\n')}
  `);
  await db.exec(SCHEMA);
  const hub = { channels: new Set() };
  const stats = { rpc: 0, selects: 0, rows: 0 };
  return { db, hub, stats, users, offline: false, failNext: null, client: (userId) => createClient({ db, hub, stats, userId, server: null }) };
}

export function clientFor(server, userId, label = 'client') {
  return createClient({ db: server.db, hub: server.hub, stats: server.stats, userId, server, label });
}

/** One serialized "request": runs inside a transaction as role `authenticated` with auth.uid() = userId. */
async function asUser({ db, userId }, fn) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role authenticated`);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId || '']);
    return fn(tx);
  });
}

function createClient(ctx) {
  const { db, hub, stats, userId, server } = ctx;
  const gate = () => {
    if (server?.offline) throw new TypeError('Failed to fetch');
    if (server?.failNext) { const f = server.failNext; server.failNext = null; return f; }
    return null;
  };
  const err = (e) => ({ data: null, error: { message: e.message, code: e.code } });

  const client = {
    auth: { getSession: async () => ({ data: { session: userId ? { user: { id: userId, email: 'me@example.com' } } : null }, error: null }) },

    rpc: async (name, args) => {
      stats.rpc++;
      try {
        const injected = gate(); if (injected) return { data: null, error: { message: injected.message, status: injected.status } };
        const data = await asUser(ctx, async (tx) => {
          if (name === 'sync_push') return (await tx.query('select public.sync_push($1,$2,$3::jsonb) as r', [args.p_dataset, args.p_device, JSON.stringify(args.p_items)])).rows[0].r;
          if (name === 'sync_list_datasets') return (await tx.query('select * from public.sync_list_datasets()')).rows.map((r) => ({ ...r, last_seq: Number(r.last_seq), record_count: Number(r.record_count) }));
          throw new Error(`unknown rpc ${name}`);
        });
        if (name === 'sync_push' && data.some((d) => d.status === 'ok')) {
          // what Supabase Realtime would do: tell OTHER subscribers of this dataset that something changed
          for (const ch of hub.channels) {
            if (ch.owner !== client && ch.userId === userId && ch.filter.includes(`=eq.${args.p_dataset}`)) setTimeout(() => ch.cb({ new: { dataset_id: args.p_dataset, device_id: args.p_device } }), 0);
          }
        }
        return { data, error: null };
      } catch (e) { if (e instanceof TypeError) throw e; return err(e); }
    },

    from: (table) => ({
      select: (cols = '*') => {
        const q = { cols, eq: [], gt: [], order: null, limit: null, single: false };
        const b = {
          eq: (c, v) => { q.eq.push([c, v]); return b; },
          gt: (c, v) => { q.gt.push([c, v]); return b; },
          order: (c, o) => { q.order = [c, o?.ascending !== false]; return b; },
          limit: (n) => { q.limit = n; return b; },
          maybeSingle: () => { q.single = true; return b; },
          then: (res, rej) => run().then(res, rej),
        };
        async function run() {
          stats.selects++;
          try {
            const injected = gate(); if (injected) return { data: null, error: { message: injected.message, status: injected.status } };
            const ok = /^[a-z_,*]+$/.test(q.cols);
            if (!ok) throw new Error('bad columns');
            const params = []; const where = [];
            for (const [c, v] of q.eq) { params.push(v); where.push(`${c} = $${params.length}`); }
            for (const [c, v] of q.gt) { params.push(v); where.push(`${c} > $${params.length}`); }
            const sql = `select ${q.cols} from public.${table}${where.length ? ` where ${where.join(' and ')}` : ''}${q.order ? ` order by ${q.order[0]} ${q.order[1] ? 'asc' : 'desc'}` : ''}${q.limit ? ` limit ${q.limit}` : ''}`;
            let rows = (await asUser(ctx, (tx) => tx.query(sql, params))).rows;
            rows = rows.map((r) => (r.seq !== undefined ? { ...r, seq: Number(r.seq), rev: Number(r.rev) } : r));
            stats.rows += rows.length;
            return { data: q.single ? (rows[0] || null) : rows, error: null };
          } catch (e) { if (e instanceof TypeError) throw e; return err(e); }
        }
        return b;
      },
      insert: async (row) => {
        try {
          await asUser(ctx, (tx) => tx.query(`insert into public.${table} (${Object.keys(row).join(',')}) values (${Object.keys(row).map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row)));
          return { error: null };
        } catch (e) { return { error: { message: e.message } }; }
      },
    }),

    channel: (name) => {
      const ch = { owner: client, userId, name, filter: '', cb: () => {}, statusCb: null };
      const api = {
        on: (type, opts, cb) => { ch.filter = opts.filter || ''; ch.cb = cb; return api; },
        subscribe: (statusCb) => { ch.statusCb = statusCb; hub.channels.add(ch); setTimeout(() => statusCb?.('SUBSCRIBED'), 0); return api; },
        _ch: ch,
      };
      return api;
    },
    removeChannel: async (api) => { hub.channels.delete(api._ch); },
  };
  return client;
}
