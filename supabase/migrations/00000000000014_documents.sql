-- Documents (`docs/TASKS.md` F3.1–F3.5): a prescription, a lab result, a
-- discharge letter, a doctor's note, each a row in a cabinet with its file in
-- the private `documents` bucket, and the links that tie one to the products
-- and boxes it names.
--
-- A document is a cabinet's row as a box is (migration 2): its own cabinet is
-- "only me", a household's is "the household", and moving one between them
-- writes it afresh there (F3.5, as `moveBox`). A subset of members would be a
-- third mechanism beside the cabinet and is not built.
--
-- The file is the photos' pattern (migration 2), with two departures:
--
-- 1. Only a live row shows its file. A move or a delete leaves a tombstone
--    still naming it, so that an undo finds it; counted, every member of a
--    household a document left, and everyone who joins it later, would keep
--    reading it. Only the uploader then reads it, as the owner of the file;
--    so only whoever added a document moves it out of a household (the app),
--    and a new row naming a file its writer cannot read loses it, as a photo's.
-- 2. The file goes up beside the push, not inside it (`src/sync/documents.ts`),
--    so the row may well arrive first; the forget trigger only drops a file
--    that is stored and unseen, as the photos' does.
--
-- A link lives in the document's cabinet and may name a product or a box in
-- any other the writer can read: a prescription kept to oneself still names
-- the household's box. A reader who cannot see the box sees a link to
-- nothing, which the app leaves out.

begin;

create table public.documents (
  cabinet_id uuid not null references public.cabinets (id) on delete cascade,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  tombstone_version bigint not null default 0 check (tombstone_version between 0 and 9007199254740991),
  person_id uuid,
  kind text not null check (kind in ('prescription', 'lab', 'discharge', 'doctor_note', 'other')),
  -- Empty only on the tombstone a move leaves, which keeps nothing to read.
  title text not null check (char_length(title) <= 120),
  issued_on date,
  note text check (char_length(note) <= 2000),
  -- An e-prescription's code or a paper one's number.
  reference text check (char_length(reference) <= 40),
  file_id uuid,
  -- The app draws a file by this, never by what Storage says it is.
  file_type text check (file_type in ('pdf', 'jpeg')),
  byte_size integer check (byte_size between 1 and 10485760),
  archived boolean not null default false,
  created_by uuid,
  primary key (cabinet_id, id),
  -- The forget trigger takes all three or none.
  check ((file_id is null) = (file_type is null) and (file_id is null) = (byte_size is null))
);

-- Its id is a hash of the document and what it names (`src/db/ids.ts`), so
-- two devices linking alike make one row.
create table public.document_links (
  cabinet_id uuid not null references public.cabinets (id) on delete cascade,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  tombstone_version bigint not null default 0 check (tombstone_version between 0 and 9007199254740991),
  document_id uuid not null,
  product_id uuid,
  package_id uuid,
  primary key (cabinet_id, id),
  check (num_nonnulls(product_id, package_id) = 1)
);

create index document_links_document on public.document_links (document_id);

do $$
declare
  t text;
begin
  foreach t in array array['documents', 'document_links'] loop
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
    execute format('create index %I on public.%I (updated_at, id)', t || '_pull', t);
    execute format(
      'create trigger set_updated_at before insert or update on public.%I for each row execute function public.set_updated_at()', t);
    execute format(
      'create trigger nudge_cabinet_insert after insert on public.%I referencing new table as new_rows
         for each statement execute function private.nudge_cabinet()', t);
    execute format(
      'create trigger nudge_cabinet_update after update on public.%I referencing new table as new_rows
         for each statement execute function private.nudge_cabinet()', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select, insert, update on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

-- Who added it, as a box's moves say who moved it (migration 11).
create trigger stamp_writer before insert or update on public.documents
  for each row execute function private.stamp_writer();

-- Migration 6's, and the two tables.
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
    left join lateral (select h.updated_at, h.id from public.product_tags h order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'documents'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.documents h order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'document_links'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.document_links h order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'offers'::text, null::timestamptz, (select private.my_offers());
$$;

-- ---------------------------------------------------------------------------
-- Files: `<file id>/file.pdf` or `…/file.jpg`, 10 MB at most.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 10485760, array['application/pdf', 'image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create function private.document_of_object(name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/file\.(pdf|jpg)$'
    then pg_catalog.split_part(name, '/', 1)::uuid
  end;
$$;

-- As the reader, so the documents policy decides; a live row only (1. above).
create function private.can_see_document(file uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select file is not null and exists (select 1 from public.documents r where r.file_id = file and r.deleted_at is null);
$$;

-- As the photos': a file some other cabinet's row names, tombstone or not, is not the caller's to place.
create function private.can_place_document(file uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select file is not null
    and not exists (select 1 from public.documents r where r.file_id = file and not private.can_write_cabinet(r.cabinet_id));
$$;

create policy documents_read on storage.objects for select to authenticated
  using (
    bucket_id = 'documents'
    and (owner_id = (select auth.uid())::text or private.can_see_document(private.document_of_object(name)))
  );

create policy documents_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and private.can_place_document(private.document_of_object(name)));

create policy documents_update on storage.objects for update to authenticated
  using (bucket_id = 'documents' and owner_id = (select auth.uid())::text)
  with check (
    bucket_id = 'documents'
    and owner_id = (select auth.uid())::text
    and private.can_place_document(private.document_of_object(name))
  );

create policy documents_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and owner_id = (select auth.uid())::text);

create function private.document_stored(file uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from storage.objects o
     where o.bucket_id = 'documents' and private.document_of_object(o.name) = file
  );
$$;

-- As the writer, so `storage.objects` answers with what they may read.
create function private.forget_unseen_document()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated'
     and new.file_id is not null
     and (tg_op = 'INSERT' or new.file_id is distinct from old.file_id)
     and private.document_stored(new.file_id)
     and not exists (
       select 1 from storage.objects o
        where o.bucket_id = 'documents' and private.document_of_object(o.name) = new.file_id
     ) then
    new.file_id := null;
    new.file_type := null;
    new.byte_size := null;
  end if;
  return new;
end;
$$;

create trigger forget_unseen_document before insert or update on public.documents
  for each row execute function private.forget_unseen_document();

-- A budget per account, as the photos' (migration 2): 200 MB is twenty
-- full-size scans, and most are a fraction of that.
create function private.keep_document_budget()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.bucket_id = 'documents' and new.owner_id is not null
     and coalesce((new.metadata ->> 'size')::bigint, 0) + coalesce((
       select sum((o.metadata ->> 'size')::bigint) from storage.objects o
        where o.bucket_id = 'documents' and o.owner_id = new.owner_id and o.id <> new.id
     ), 0) > 209715200 then
    raise exception 'document budget' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger keep_document_budget before insert or update on storage.objects
  for each row execute function private.keep_document_budget();

create function definers.own_document_objects()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name from storage.objects o
   where o.bucket_id = 'documents' and o.owner_id = (select auth.uid())::text;
$$;

-- A month old at least, as the photos': a device may hold the row unsent.
create function definers.unnamed_documents()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name from storage.objects o
   where o.bucket_id = 'documents' and o.owner_id = (select auth.uid())::text
     and o.created_at < now() - interval '30 days'
     and not exists (select 1 from public.documents r where r.file_id = private.document_of_object(o.name) and r.deleted_at is null);
$$;

create function public.own_document_objects()
returns setof text language sql stable security invoker set search_path = ''
as $$ select definers.own_document_objects() $$;
create function public.unnamed_documents()
returns setof text language sql stable security invoker set search_path = ''
as $$ select definers.unnamed_documents() $$;

revoke all on function private.document_of_object(text) from public, anon;
revoke all on function private.can_see_document(uuid) from public, anon;
revoke all on function private.can_place_document(uuid) from public, anon;
revoke all on function private.document_stored(uuid) from public, anon;
revoke all on function private.forget_unseen_document() from public, anon, authenticated;
revoke all on function private.keep_document_budget() from public, anon, authenticated;
revoke all on function definers.own_document_objects() from public, anon, authenticated, service_role;
revoke all on function definers.unnamed_documents() from public, anon, authenticated, service_role;
revoke all on function public.own_document_objects() from public, anon, authenticated, service_role;
revoke all on function public.unnamed_documents() from public, anon, authenticated, service_role;
grant execute on function private.document_of_object(text) to authenticated;
grant execute on function private.can_see_document(uuid) to authenticated;
grant execute on function private.can_place_document(uuid) to authenticated;
grant execute on function private.document_stored(uuid) to authenticated;
grant execute on function definers.own_document_objects() to authenticated;
grant execute on function definers.unnamed_documents() to authenticated;
grant execute on function public.own_document_objects() to authenticated;
grant execute on function public.unnamed_documents() to authenticated;

commit;
