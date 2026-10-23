-- The medicine cabinet's tables (SPEC 7, `docs/TASKS.md` F1.5, F1.17, F1.21):
-- the people a box is for, the places it is kept, products and their tags,
-- boxes, what went into or out of each and what an edit changed on it; and
-- the photos a person, a product or a box carries.
--
-- Every row is scoped by its cabinet, not its person (`docs/ARCHITECTURE.md`
-- "A cabinet scopes every medicine row"): `cabinet_id`, part of the primary
-- key, on every table, so no policy joins a parent. Until sharing a person's
-- cabinet is their account, so `cabinet_id` references `auth.users`; sharing
-- adds the cabinets a household holds and rewrites the bodies of the two
-- helpers below, and no policy here changes.
--
-- References between rows are not foreign keys: a child may reach the server
-- before its parent, as it does in Helix and Gital, and a delete is a
-- tombstone that leaves the parent row in place.

begin;

-- ---------------------------------------------------------------------------
-- Who may read and write a cabinet
-- ---------------------------------------------------------------------------

-- Invoker rights: today's body reads no table, so it needs none of its
-- owner's. The body sharing gives them reads the membership table, and takes
-- definer rights with it, as Gital's `can_read_list` does.
create function private.can_read_cabinet(cabinet uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$ select cabinet = (select auth.uid()) $$;

create function private.can_write_cabinet(cabinet uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$ select cabinet = (select auth.uid()) $$;

revoke all on function private.can_read_cabinet(uuid) from public, anon;
revoke all on function private.can_write_cabinet(uuid) from public, anon;
grant execute on function private.can_read_cabinet(uuid) to authenticated, service_role;
grant execute on function private.can_write_cabinet(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The tables; the device's are in `src/db/schema.ts`
-- ---------------------------------------------------------------------------

-- A person a box is for, who need not hold an account: a child, a parent
-- cared for, a pet.
create table public.people (
  cabinet_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  tombstone_version bigint not null default 0 check (tombstone_version >= 0),
  name text not null check (char_length(name) between 1 and 80),
  kind text not null default 'person' check (kind in ('self', 'person', 'pet')),
  color text check (color in ('red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink')),
  warn_days integer check (warn_days between 1 and 365),
  photo_id uuid,
  primary key (cabinet_id, id)
);

create table public.locations (
  cabinet_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  tombstone_version bigint not null default 0 check (tombstone_version >= 0),
  name text not null check (char_length(name) between 1 and 80),
  primary key (cabinet_id, id)
);

-- One with a GTIN takes its id from cabinet and GTIN, so two devices scanning
-- one box make one product; the GTIN itself is not unique, since a product
-- deleted and made again by hand may name it twice.
create table public.products (
  cabinet_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  tombstone_version bigint not null default 0 check (tombstone_version >= 0),
  name text not null check (char_length(name) between 1 and 200),
  brand text check (char_length(brand) <= 200),
  active_substance text check (char_length(active_substance) <= 500),
  strength text check (char_length(strength) <= 100),
  form text check (char_length(form) <= 100),
  pack text check (char_length(pack) <= 100),
  manufacturer text check (char_length(manufacturer) <= 200),
  gtin text check (gtin ~ '^[0-9]{8,14}$'),
  note text check (char_length(note) <= 2000),
  starred boolean not null default false,
  wanted boolean not null default false,
  photo_id uuid,
  primary key (cabinet_id, id)
);

-- A category or a tag: one kind of thing, named by the cabinet.
create table public.tags (
  cabinet_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  tombstone_version bigint not null default 0 check (tombstone_version >= 0),
  name text not null check (char_length(name) between 1 and 80),
  primary key (cabinet_id, id)
);

-- A tag on a product. Its id is a hash of the two, so the pair is one row
-- wherever it was made; taking the tag off tombstones it.
create table public.product_tags (
  cabinet_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  tombstone_version bigint not null default 0 check (tombstone_version >= 0),
  product_id uuid not null,
  tag_id uuid not null,
  primary key (cabinet_id, id)
);

-- One physical box. Its days are the person's calendar days, with no zone,
-- so a box that runs out on the 31st does so on the 31st wherever it is read.
create table public.packages (
  cabinet_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  tombstone_version bigint not null default 0 check (tombstone_version >= 0),
  product_id uuid not null,
  person_id uuid,
  location_id uuid,
  unit text not null check (unit in ('adet', 'tablet', 'kapsul', 'ml', 'doz', 'tup')),
  expires_on date,
  opened_on date,
  -- Ten years opened is past any medicine; a threshold is in the moves' thousandths.
  use_within_days integer check (use_within_days between 1 and 3650),
  low_milli bigint check (low_milli between 1 and 1000000000),
  serial text check (char_length(serial) <= 20),
  lot text check (char_length(lot) <= 20),
  nickname text check (char_length(nickname) <= 80),
  acquired_on date,
  acquired_from text check (char_length(acquired_from) <= 200),
  note text check (char_length(note) <= 2000),
  -- None is a box still at home; open, empty and expired are read from its other columns.
  disposition text check (disposition in ('lost', 'disposed', 'archived')),
  warn_days integer check (warn_days between 1 and 365),
  photo_id uuid,
  primary key (cabinet_id, id)
);

-- In thousandths of the box's unit. A move of nothing is refused, and one
-- past a million units is a typing slip, not a box.
create table public.package_moves (
  cabinet_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  tombstone_version bigint not null default 0 check (tombstone_version >= 0),
  package_id uuid not null,
  quantity_milli bigint not null check (quantity_milli <> 0 and abs(quantity_milli) <= 1000000000),
  reason text not null check (reason in ('initial', 'use', 'add', 'correction')),
  primary key (cabinet_id, id)
);

-- What an edit changed on a box: each field, before and after, as the
-- device's JSON. Two texts of the longest field fit.
create table public.package_changes (
  cabinet_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  tombstone_version bigint not null default 0 check (tombstone_version >= 0),
  package_id uuid not null,
  changes text not null check (char_length(changes) between 2 and 8000),
  primary key (cabinet_id, id)
);

do $$
declare
  t text;
begin
  foreach t in array array['people', 'locations', 'products', 'packages', 'package_moves', 'package_changes', 'tags', 'product_tags'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (private.can_read_cabinet(cabinet_id))',
      t || '_select', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (private.can_write_cabinet(cabinet_id))',
      t || '_insert', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (private.can_write_cabinet(cabinet_id)) with check (private.can_write_cabinet(cabinet_id))',
      t || '_update', t);
    -- A pull names no cabinet, and a policy's function call is not inlined,
    -- so the pull's order leads; the primary key serves the cabinet.
    execute format('create index %I on public.%I (updated_at, id)', t || '_pull', t);
    execute format(
      'create trigger set_updated_at before insert or update on public.%I for each row execute function public.set_updated_at()', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select, insert, update on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The change probe, with the cabinet's tables in its union. The policies
-- filter them, so the probe names what the caller may read and no more.
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

revoke all on function public.sync_cursors() from public, anon, service_role;
grant execute on function public.sync_cursors() to authenticated;

-- ---------------------------------------------------------------------------
-- Photos: Gital's, scoped by the cabinet. Each is two JPEGs in the private
-- `photos` bucket, `<photo id>/full.jpg` and `…/thumb.jpg`, sent before the
-- row naming it (`src/sync/photos.ts`). Whoever can read a row naming a photo
-- may read it; only the uploader overwrites or removes it. JPEG only, 2 MB,
-- ten times what the app's photo weighs.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 2097152, array['image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The photo an object name holds, or null for a name the app never makes.
create function private.photo_of_object(name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(full|thumb)\.jpg$'
    then pg_catalog.split_part(name, '/', 1)::uuid
  end;
$$;

-- Invoker rights on purpose: the caller's own policies on the three tables
-- decide which rows it can see, so this can never widen them.
create function private.can_see_photo(photo uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select photo is not null and (
    exists (select 1 from public.people r where r.photo_id = photo)
    or exists (select 1 from public.products r where r.photo_id = photo)
    or exists (select 1 from public.packages r where r.photo_id = photo)
  );
$$;

-- Definer rights, so a row the caller cannot read still counts: a photo some
-- other cabinet's row names is not theirs to place, under any name.
create function private.can_place_photo(photo uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select photo is not null
    and not exists (select 1 from public.people r where r.photo_id = photo and not private.can_write_cabinet(r.cabinet_id))
    and not exists (select 1 from public.products r where r.photo_id = photo and not private.can_write_cabinet(r.cabinet_id))
    and not exists (select 1 from public.packages r where r.photo_id = photo and not private.can_write_cabinet(r.cabinet_id));
$$;

create policy photos_read on storage.objects for select to authenticated
  using (
    bucket_id = 'photos'
    and (owner_id = (select auth.uid())::text or private.can_see_photo(private.photo_of_object(name)))
  );

create policy photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and private.can_place_photo(private.photo_of_object(name)));

-- Storage authorises a move as an update of the object's name.
create policy photos_update on storage.objects for update to authenticated
  using (bucket_id = 'photos' and owner_id = (select auth.uid())::text)
  with check (
    bucket_id = 'photos'
    and owner_id = (select auth.uid())::text
    and private.can_place_photo(private.photo_of_object(name))
  );

create policy photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and owner_id = (select auth.uid())::text);

-- A row may name a photo that is not there yet (the app sends a photo before
-- its row, and one Storage refused for good goes up unnamed) or one its
-- writer can already read; any other is dropped from the row rather than
-- refused, so the device's outbox is never held by it. Gital's migration 16.
create function private.photo_stored(photo uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from storage.objects o
     where o.bucket_id = 'photos' and private.photo_of_object(o.name) = photo
  );
$$;

-- As the writer, so `storage.objects` answers with what they may read.
create function private.forget_unseen_photo()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated'
     and new.photo_id is not null
     and (tg_op = 'INSERT' or new.photo_id is distinct from old.photo_id)
     and private.photo_stored(new.photo_id)
     and not exists (
       select 1 from storage.objects o
        where o.bucket_id = 'photos' and private.photo_of_object(o.name) = new.photo_id
     ) then
    new.photo_id := null;
  end if;
  return new;
end;
$$;

create trigger forget_unseen_photo before insert or update on public.people
  for each row execute function private.forget_unseen_photo();
create trigger forget_unseen_photo before insert or update on public.products
  for each row execute function private.forget_unseen_photo();
create trigger forget_unseen_photo before insert or update on public.packages
  for each row execute function private.forget_unseen_photo();

-- A photo budget per account, so one cannot fill the bucket for everyone.
-- Storage writes the object's row as itself with the size, and a refusal
-- there leaves no file behind (Gital, measured 2026-10-09). 100 MB is about
-- 450 photos with their thumbnails. Refused as a policy refusal is, so the
-- device passes the photo over and its row goes up without it.
create function private.keep_photo_budget()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.bucket_id = 'photos' and new.owner_id is not null
     and coalesce((new.metadata ->> 'size')::bigint, 0) + coalesce((
       select sum((o.metadata ->> 'size')::bigint) from storage.objects o
        where o.bucket_id = 'photos' and o.owner_id = new.owner_id and o.id <> new.id
     ), 0) > 104857600 then
    raise exception 'photo budget' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger keep_photo_budget before insert or update on storage.objects
  for each row execute function private.keep_photo_budget();

-- What a deleted account's device removes through the Storage API first:
-- Storage refuses a delete against its tables, and nothing cascades to it.
create function definers.own_photo_objects()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name from storage.objects o
   where o.bucket_id = 'photos' and o.owner_id = (select auth.uid())::text;
$$;

-- The photos no row names any more: replaced, undone, or gone with their row.
-- A month old at least, since a photo goes up before the row naming it and a
-- device may hold that row unsent.
create function definers.unnamed_photos()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name from storage.objects o
   where o.bucket_id = 'photos' and o.owner_id = (select auth.uid())::text
     and o.created_at < now() - interval '30 days'
     and not exists (select 1 from public.people r where r.photo_id = private.photo_of_object(o.name) and r.deleted_at is null)
     and not exists (select 1 from public.products r where r.photo_id = private.photo_of_object(o.name) and r.deleted_at is null)
     and not exists (select 1 from public.packages r where r.photo_id = private.photo_of_object(o.name) and r.deleted_at is null);
$$;

create function public.own_photo_objects()
returns setof text language sql stable security invoker set search_path = ''
as $$ select definers.own_photo_objects() $$;
create function public.unnamed_photos()
returns setof text language sql stable security invoker set search_path = ''
as $$ select definers.unnamed_photos() $$;

revoke all on function private.photo_of_object(text) from public, anon;
revoke all on function private.can_see_photo(uuid) from public, anon;
revoke all on function private.can_place_photo(uuid) from public, anon;
revoke all on function private.photo_stored(uuid) from public, anon;
revoke all on function private.forget_unseen_photo() from public, anon, authenticated;
revoke all on function private.keep_photo_budget() from public, anon, authenticated;
revoke all on function definers.own_photo_objects() from public, anon, authenticated, service_role;
revoke all on function definers.unnamed_photos() from public, anon, authenticated, service_role;
revoke all on function public.own_photo_objects() from public, anon, authenticated, service_role;
revoke all on function public.unnamed_photos() from public, anon, authenticated, service_role;
grant execute on function private.photo_of_object(text) to authenticated;
grant execute on function private.can_see_photo(uuid) to authenticated;
grant execute on function private.can_place_photo(uuid) to authenticated;
grant execute on function private.photo_stored(uuid) to authenticated;
grant execute on function definers.own_photo_objects() to authenticated;
grant execute on function definers.unnamed_photos() to authenticated;
grant execute on function public.own_photo_objects() to authenticated;
grant execute on function public.unnamed_photos() to authenticated;

commit;
