-- ============================================================================
-- Finora — Supabase schema (end-to-end-encrypted sync)
-- Run ONCE: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run (everything is "if not exists" / "create or replace").
--
-- Design (cross-checked with the Supabase docs: RLS, Realtime Postgres Changes, PostgREST limits)
--   * The server stores only CIPHERTEXT. The encryption key comes from the user's passphrase
--     and never leaves the device, so Supabase (and anyone who breaches it) cannot read finances.
--     The server can see: which user, which table-name ("ledger"), a record id, sizes, timestamps.
--   * Row Level Security: a user can only ever read/write rows where user_id = auth.uid().
--   * NO hard deletes (there is no DELETE policy): a delete is a row with deleted=true.
--     Reason (Realtime docs): DELETE events are NOT filtered by RLS, so a real DELETE could leak
--     to other subscribers; an UPDATE to a tombstone is fully RLS-protected.
--   * Every write gets a server-assigned, increasing `seq` — clients pull "everything after seq N".
--   * `sync_push()` is ONE atomic call per batch with optimistic concurrency (base_rev), instead of
--     many separate requests that could half-succeed.
--   * Realtime is only a HINT ("something changed, pull now"); correctness never depends on it.
-- ============================================================================

-- ---------- 1. per-user encryption profile (salt + passphrase check, NOT the key) ----------
create table if not exists public.sync_profiles (
  user_id        uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  kdf_salt       text    not null,                       -- random, base64; lets a 2nd device derive the same key
  kdf_iterations integer not null default 600000 check (kdf_iterations between 100000 and 5000000),
  verifier       text    not null,                       -- a known string encrypted with the key: "is the passphrase right?"
  created_at     timestamptz not null default now()
);
alter table public.sync_profiles enable row level security;

drop policy if exists "sync_profiles: read own"   on public.sync_profiles;
drop policy if exists "sync_profiles: insert own" on public.sync_profiles;
create policy "sync_profiles: read own"   on public.sync_profiles for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "sync_profiles: insert own" on public.sync_profiles for insert to authenticated
  with check ((select auth.uid()) = user_id);
-- (no update/delete policy on purpose: changing the passphrase means re-encrypting everything — done client-side later)

-- ---------- 2. the synced records ----------
create sequence if not exists public.sync_seq;

create table if not exists public.sync_records (
  user_id    uuid    not null default auth.uid() references auth.users(id) on delete cascade,
  dataset_id text    not null check (char_length(dataset_id) between 1 and 80),   -- one per Finora profile's data
  store      text    not null check (char_length(store) between 1 and 40),        -- 'ledger', 'accounts', ...
  record_id  text    not null check (char_length(record_id) between 1 and 160),
  rev        bigint  not null default 1,                                          -- per-record revision (server-incremented)
  seq        bigint  not null,                                                    -- global increasing cursor (set by trigger)
  deleted    boolean not null default false,                                      -- tombstone
  payload    text    not null check (char_length(payload) <= 2000000),            -- base64(iv || AES-GCM ciphertext)
  device_id  text    not null check (char_length(device_id) <= 40),
  updated_at timestamptz not null default now(),
  primary key (user_id, dataset_id, store, record_id)
);
create index if not exists sync_records_pull_idx on public.sync_records (user_id, dataset_id, seq);

alter table public.sync_records enable row level security;

drop policy if exists "sync_records: read own"   on public.sync_records;
drop policy if exists "sync_records: insert own" on public.sync_records;
drop policy if exists "sync_records: update own" on public.sync_records;
create policy "sync_records: read own"   on public.sync_records for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "sync_records: insert own" on public.sync_records for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "sync_records: update own" on public.sync_records for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
-- no DELETE policy => hard deletes are impossible for clients (tombstones only)

-- server-controlled bookkeeping: clients cannot forge seq / rev / updated_at
create or replace function public.sync_records_before_write()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  new.seq := nextval('public.sync_seq');
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.rev := old.rev + 1;
  else
    new.rev := 1;
  end if;
  return new;
end $$;

drop trigger if exists sync_records_before_write on public.sync_records;
create trigger sync_records_before_write
  before insert or update on public.sync_records
  for each row execute function public.sync_records_before_write();

-- ---------- 3. atomic batch push with optimistic concurrency ----------
-- p_items: [{ "store": "ledger", "record_id": "TXN-...", "base_rev": 0, "deleted": false, "payload": "..." }, ...]
--   base_rev = the revision the client last saw (0 = "this is a new record").
-- Returns one result per item: {store, record_id, status: 'ok'|'conflict', rev, seq}
--   'conflict' = somebody else changed it since base_rev; nothing was written for that item.
create or replace function public.sync_push(p_dataset text, p_device text, p_items jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  it      jsonb;
  v_rev   bigint;
  v_base  bigint;
  v_seq   bigint;
  v_out   jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then
    raise exception 'p_items must be an array of at most 500 items';
  end if;

  for it in select * from jsonb_array_elements(p_items) loop
    v_base := coalesce((it->>'base_rev')::bigint, 0);

    select rev into v_rev from public.sync_records
     where user_id = auth.uid() and dataset_id = p_dataset
       and store = it->>'store' and record_id = it->>'record_id'
     for update;

    if not found then
      insert into public.sync_records (dataset_id, store, record_id, deleted, payload, device_id)
      values (p_dataset, it->>'store', it->>'record_id', coalesce((it->>'deleted')::boolean, false), it->>'payload', p_device)
      returning rev, seq into v_rev, v_seq;
      v_out := v_out || jsonb_build_object('store', it->>'store', 'record_id', it->>'record_id', 'status', 'ok', 'rev', v_rev, 'seq', v_seq);

    elsif v_rev = v_base then
      update public.sync_records
         set deleted = coalesce((it->>'deleted')::boolean, false), payload = it->>'payload', device_id = p_device
       where user_id = auth.uid() and dataset_id = p_dataset
         and store = it->>'store' and record_id = it->>'record_id'
      returning rev, seq into v_rev, v_seq;
      v_out := v_out || jsonb_build_object('store', it->>'store', 'record_id', it->>'record_id', 'status', 'ok', 'rev', v_rev, 'seq', v_seq);

    else
      v_out := v_out || jsonb_build_object('store', it->>'store', 'record_id', it->>'record_id', 'status', 'conflict', 'rev', v_rev);
    end if;
  end loop;

  return v_out;
end $$;

-- ---------- 3b. which datasets do I have? (lets a new device JOIN an existing one) ----------
create or replace function public.sync_list_datasets()
returns table (dataset_id text, record_count bigint, last_seq bigint, updated_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select r.dataset_id,
         count(*) filter (where not r.deleted),
         max(r.seq),
         max(r.updated_at)
    from public.sync_records r
   where r.user_id = auth.uid()
   group by r.dataset_id
   order by max(r.seq) desc
$$;

-- ---------- 4. privileges: signed-in users only, nothing for anonymous visitors ----------
revoke all on public.sync_profiles from anon;
revoke all on public.sync_records  from anon;
grant select, insert         on public.sync_profiles to authenticated;
grant select, insert, update on public.sync_records  to authenticated;
grant usage, select          on sequence public.sync_seq to authenticated;
revoke all on function public.sync_push(text, text, jsonb) from public, anon;
grant execute on function public.sync_push(text, text, jsonb) to authenticated;
revoke all on function public.sync_list_datasets() from public, anon;
grant execute on function public.sync_list_datasets() to authenticated;

-- ---------- 5. Realtime: tell the browser "something changed" (it then pulls) ----------
-- (The Realtime docs: a table must be in the supabase_realtime publication. RLS still applies to what each user receives.)
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sync_records') then
    alter publication supabase_realtime add table public.sync_records;
  end if;
end $$;
