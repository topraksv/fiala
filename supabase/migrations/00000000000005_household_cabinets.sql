-- A household's cabinet is made on a device (`docs/TASKS.md` F2.4), as Gital's
-- lists are: offline, and named by the device that made it. Migration 4 let
-- only the server make a cabinet; that stays true of the personal one, whose
-- id is its account's. Rejected: a server function that makes a household,
-- which would not run offline, and the name would still need a way back from
-- the device.
--
-- And the two members' tables join the change probe, so a device pulls them.

begin;

alter table public.cabinets
  add column name text not null default '' check (char_length(name) <= 60);

-- Whether an id is an account's: a member sees others' ids in
-- `cabinet_members`, and a cabinet made with one would take that person's
-- personal cabinet before the server makes it (Gital's migration 12).
create function private.is_account(person uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from auth.users u where u.id = person);
$$;
revoke all on function private.is_account(uuid) from public, anon;
grant execute on function private.is_account(uuid) to authenticated;

create policy cabinets_insert on public.cabinets for insert to authenticated
  with check (owner_id = (select auth.uid()) and not private.is_account(id));
-- The owner alone renames or deletes a cabinet. An upsert asks the insert's
-- policy too, which an existing household passes: its id is no account's.
create policy cabinets_update on public.cabinets for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
grant insert, update on table public.cabinets to authenticated;

-- The owner is who made the cabinet, for ever; and the personal one lives as
-- long as its account, since every row a device writes before a household
-- names it.
create function private.keep_cabinet_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.owner_id := old.owner_id;
  if old.id = old.owner_id then
    new.deleted_at := old.deleted_at;
    new.tombstone_version := old.tombstone_version;
  end if;
  return new;
end;
$$;
revoke all on function private.keep_cabinet_owner() from public, anon, authenticated;

-- Before `set_updated_at`; triggers run by name.
create trigger keep_cabinet_owner before update on public.cabinets
  for each row execute function private.keep_cabinet_owner();

create index cabinets_pull on public.cabinets (updated_at, id);

-- ---------------------------------------------------------------------------
-- The change probe, with the cabinets and their members. The policies filter
-- them, so the probe names what the caller may read and no more.
-- ---------------------------------------------------------------------------

create or replace function public.sync_cursors()
returns table (table_name text, max_updated_at timestamptz, max_id uuid)
language sql
security invoker
stable
set search_path = ''
as $$
  select 'settings'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.settings h where h.user_id = (select auth.uid()) order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'cabinets'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.cabinets h order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'cabinet_members'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.cabinet_members h order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'people'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.people h order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'locations'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.locations h order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'products'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.products h order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'packages'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.packages h order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'package_moves'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.package_moves h order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'package_changes'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.package_changes h order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'tags'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.tags h order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'product_tags'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.product_tags h order by h.updated_at desc, h.id desc limit 1) k on true;
$$;

commit;
