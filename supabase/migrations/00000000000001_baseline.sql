-- The baseline: everything the shell needs on the server, in one migration
-- because nothing was deployed before it. Helix's conventions, ported as they
-- stand; a feature adds its tables in migrations of its own, after this one.
--
--   - the heartbeat that keeps a free project awake;
--   - sync and settings: the Postgres side of every table the device writes;
--   - the account deleting itself;
--   - the feedback send limit;
--   - the `private` schema RLS helpers live in, and the `definers` schema the
--     SECURITY DEFINER functions of the client's API live behind.
--
-- A row is scoped by its person: `user_id`, part of the primary key, because
-- a row's id may be a hash of what it names, and two people name the same
-- things. The device holds one account and keeps `id` alone.
--
-- `updated_at` is the server's clock and a delete generation outranks it, as
-- in Helix: a device that never saw a delete cannot undo it by writing later.
-- Deletes are tombstones; the client holds no DELETE privilege.

begin;

-- ---------------------------------------------------------------------------
-- The heartbeat
-- ---------------------------------------------------------------------------

-- The free plan pauses a project after about seven days without traffic, and
-- the app may go unopened for longer than that. `.github/workflows/keepalive.yml`
-- upserts and reads this one row every three days with the service-role key.
-- It is not user data and has no owner column, so no client role may touch it.
create table public.keep_alive (
  id int primary key,
  pinged_at timestamptz not null default now()
);

alter table public.keep_alive enable row level security;
create policy keep_alive_service_role on public.keep_alive for all to service_role using (true) with check (true);

revoke all on table public.keep_alive from anon, authenticated;
grant all on table public.keep_alive to service_role;

-- ---------------------------------------------------------------------------
-- Sync and settings
-- ---------------------------------------------------------------------------

-- Helix's trigger (its migration 12), unchanged.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.deleted_at is not null and new.tombstone_version = 0 then
      new.tombstone_version := 1;
    end if;
  else
    -- An older client did not observe the latest delete/undo generation. Keep
    -- the server row and return it through PostgREST so the client converges.
    if new.tombstone_version < old.tombstone_version then
      return old;
    end if;

    if old.deleted_at is null and new.deleted_at is not null then
      if new.tombstone_version not in (old.tombstone_version, old.tombstone_version + 1) then
        raise check_violation using message = 'invalid tombstone generation';
      end if;
      new.tombstone_version := old.tombstone_version + 1;
    elsif new.tombstone_version <> old.tombstone_version then
      raise check_violation using message = 'invalid tombstone generation';
    end if;
  end if;

  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

-- What follows the person to every device: a key and its JSON value. Today
-- whether the account is frozen, which has to reach every device the account
-- holds, and each device's last sign-in. Its id is a hash of the key.
create table public.settings (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  tombstone_version bigint not null default 0 check (tombstone_version >= 0),
  key text not null check (char_length(key) between 1 and 64),
  value text not null check (char_length(value) <= 10000),
  primary key (user_id, id)
);

alter table public.settings enable row level security;
create policy settings_select on public.settings for select to authenticated
  using (user_id = (select auth.uid()));
create policy settings_insert on public.settings for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy settings_update on public.settings for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create index settings_pull on public.settings (user_id, updated_at, id);

create trigger set_updated_at before insert or update on public.settings
  for each row execute function public.set_updated_at();
revoke all on table public.settings from anon, authenticated;
grant select, insert, update on table public.settings to authenticated;
grant all on table public.settings to service_role;

-- The change probe (Helix's migration 32): one keyset head per table, so a
-- sync pulls only the tables that moved. Invoker rights, so it sees what the
-- caller's policies let it see and nothing more. Each table a feature adds
-- joins the union.
create or replace function public.sync_cursors()
returns table (table_name text, max_updated_at timestamptz, max_id uuid)
language sql
security invoker
stable
set search_path = ''
as $$
  select 'settings'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.settings h where h.user_id = (select auth.uid()) order by h.updated_at desc, h.id desc limit 1) k on true;
$$;

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.sync_cursors() from public, anon, service_role;
grant execute on function public.sync_cursors() to authenticated;

-- ---------------------------------------------------------------------------
-- Feedback's send limit
-- ---------------------------------------------------------------------------

-- `send-feedback` mails the owner through one Gmail account, sign-up is open,
-- and any account could repeat a valid report until the account's quota was
-- spent. The function is a public endpoint, so the limit lives here, not in
-- its memory. A signed-out report has no account: its rows carry a null
-- `user_id` and share one ceiling.
create table public.feedback_reports (
  id uuid primary key default gen_random_uuid(),
  -- Goes with the account: nothing here outlives the person it counted.
  user_id uuid references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index feedback_reports_user_created on public.feedback_reports (user_id, created_at desc);

-- Enabled, and with a policy that refuses client roles: it is reached through
-- the definer functions below alone.
alter table public.feedback_reports enable row level security;
create policy feedback_reports_no_client on public.feedback_reports
  as restrictive for all to anon, authenticated using (false) with check (false);

revoke all on table public.feedback_reports from public, anon, authenticated;
grant all on table public.feedback_reports to service_role;

-- ---------------------------------------------------------------------------
-- Schemas: `private` for what RLS calls, `definers` for the client's API
-- ---------------------------------------------------------------------------

-- In `public` PostgREST serves each SECURITY DEFINER function as an RPC, so a
-- helper a policy calls would answer any signed-in account. A policy holds its
-- function by OID: the helpers live here. `authenticated` keeps USAGE because
-- a policy runs as the requesting role; the API serves only `public` and
-- `graphql_public` (`config.toml`), so nothing here is reachable by URL.
create schema private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- The security advisor flags every SECURITY DEFINER function a client role can
-- call through `/rest/v1/rpc` (lints 0028, 0029). These are the client's API
-- on purpose, so each needs its owner's rights for rows the caller cannot
-- reach. The definer lives in a schema PostgREST does not expose, and `public`
-- keeps an invoker with the same name, arguments and grants that calls it.
-- The invoker runs as the caller, so the caller's roles need USAGE here;
-- `definers` is not exposed, so USAGE opens no new route.
create schema definers;
revoke all on schema definers from public;
grant usage on schema definers to anon, authenticated, service_role;

-- An account deletes itself. The identity lives in auth.users, which only an
-- admin may delete from; a function with no argument lets a signed-in user
-- remove their own row and no other, without the service-role key ever
-- reaching the app. Each owner column references auth.users on delete
-- cascade, so this one delete takes the account's rows in the same transaction.
create function definers.delete_own_account()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.users where id = auth.uid();
$$;

-- True when the report may go out. A yes or a no: a count left would be one
-- more thing to tune an abuse against. Five an hour stops a burst, twenty a
-- day a patient sender. A transaction-scoped advisory lock on the account
-- makes a second call wait for the first to commit and then count its row, so
-- overlapping calls cannot all read one count and all pass it.
create function definers.record_feedback_send()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  account uuid := auth.uid();
  recent integer;
  today integer;
begin
  if account is null then
    return false;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('record_feedback_send:' || account::text, 0)
  );
  -- Past the wider window a row can never change an answer again.
  delete from public.feedback_reports
   where user_id = account
     and created_at < pg_catalog.now() - interval '1 day';

  select
    count(*) filter (where created_at > pg_catalog.now() - interval '1 hour'),
    count(*)
    into recent, today
    from public.feedback_reports
   where user_id = account;

  if recent >= 5 or today >= 20 then
    return false;
  end if;

  insert into public.feedback_reports (user_id) values (account);
  return true;
end $$;

create function definers.record_signed_out_feedback_send()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- One at a time, so two in flight cannot both read nine.
  perform pg_catalog.pg_advisory_xact_lock(13);
  delete from public.feedback_reports
   where user_id is null and created_at < pg_catalog.now() - interval '1 day';
  if (select count(*) from public.feedback_reports where user_id is null) >= 10 then
    return false;
  end if;
  insert into public.feedback_reports (user_id) values (null);
  return true;
end $$;

create function public.delete_own_account()
returns void language sql security invoker set search_path = ''
as $$ select definers.delete_own_account() $$;

create function public.record_feedback_send()
returns boolean language sql security invoker set search_path = ''
as $$ select definers.record_feedback_send() $$;

create function public.record_signed_out_feedback_send()
returns boolean language sql security invoker set search_path = ''
as $$ select definers.record_signed_out_feedback_send() $$;

alter function definers.delete_own_account() owner to postgres;
revoke all on function definers.delete_own_account() from public, anon, authenticated, service_role;
revoke all on function definers.record_feedback_send() from public, anon, authenticated, service_role;
revoke all on function definers.record_signed_out_feedback_send() from public, anon, authenticated, service_role;
grant execute on function definers.delete_own_account() to authenticated;
grant execute on function definers.record_feedback_send() to authenticated, service_role;
grant execute on function definers.record_signed_out_feedback_send() to anon, service_role;

revoke all on function public.delete_own_account() from public, anon, authenticated, service_role;
revoke all on function public.record_feedback_send() from public, anon, authenticated, service_role;
revoke all on function public.record_signed_out_feedback_send() from public, anon, authenticated, service_role;
grant execute on function public.delete_own_account() to authenticated;
grant execute on function public.record_feedback_send() to authenticated, service_role;
grant execute on function public.record_signed_out_feedback_send() to anon, service_role;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from public, anon, authenticated;

commit;
