-- A document shown to chosen members of its household (F3.5's third audience).
--
-- `readers` holds their account ids, lowercase, sorted, comma-joined; null is
-- the whole household, as every row before this one. Its writer always reads
-- it. The household's owner reads it only when chosen: who else sees a health
-- record is the writer's choice, and the owner's wider reach waits on the
-- owner of the app (`docs/BACKLOG.md`). One helper holds the rule, so it is a
-- line to change.
--
-- The column is pinned on update. A change of readers is a new row and a
-- tombstone on the old one, as `moveDocument` moves a document: those who
-- lose it still read the old row, so they pull its tombstone and drop the
-- file; a reader removed in place would never hear of it. A device that does
-- not know the column cannot send it, and the pin keeps it all the same.
--
-- Storage follows by itself: `can_see_document` asks `documents` as its
-- caller, through the policies below. A link names its document, so a link
-- is read only beside a document its reader may read.
begin;

alter table public.documents add column readers text check (
  readers ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*$'
);

create function private.reads_document(writer uuid, readers text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select readers is null
      or writer = (select auth.uid())
      or (select auth.uid())::text = any (pg_catalog.string_to_array(readers, ','));
$$;

revoke all on function private.reads_document(uuid, text) from public, anon;
grant execute on function private.reads_document(uuid, text) to authenticated;

create function private.keep_readers()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' then
    new.readers := old.readers;
  end if;
  return new;
end;
$$;

revoke all on function private.keep_readers() from public, anon, authenticated;

create trigger keep_readers before update of readers on public.documents
  for each row execute function private.keep_readers();

drop policy documents_select on public.documents;
drop policy documents_insert on public.documents;
drop policy documents_update on public.documents;
create policy documents_select on public.documents for select to authenticated
  using (private.can_read_cabinet(cabinet_id) and private.reads_document(created_by, readers));
create policy documents_insert on public.documents for insert to authenticated
  with check (private.can_write_cabinet(cabinet_id) and private.reads_document(created_by, readers));
create policy documents_update on public.documents for update to authenticated
  using (private.can_write_cabinet(cabinet_id) and private.reads_document(created_by, readers))
  with check (private.can_write_cabinet(cabinet_id) and private.reads_document(created_by, readers));

-- Documents are sent before their links (`TABLES`, src/sync/engine.ts), so a
-- link a reader may see never lands before its document does.
drop policy document_links_select on public.document_links;
drop policy document_links_update on public.document_links;
create policy document_links_select on public.document_links for select to authenticated
  using (
    private.can_read_cabinet(cabinet_id)
    and exists (select 1 from public.documents d where d.cabinet_id = document_links.cabinet_id and d.id = document_links.document_id)
  );
create policy document_links_update on public.document_links for update to authenticated
  using (
    private.can_write_cabinet(cabinet_id)
    and exists (select 1 from public.documents d where d.cabinet_id = document_links.cabinet_id and d.id = document_links.document_id)
  )
  with check (private.can_write_cabinet(cabinet_id));

-- A file is placed at an id only by one who may read every row naming it.
-- Before readers, a row a member could write was one they could read; now a
-- member left out of a household document could upload under its file's id,
-- name it in a row of their own, and read the writer's file through that row.
create or replace function private.can_place_document(file uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select file is not null
    and not exists (
      select 1 from public.documents r
       where r.file_id = file
         and (not private.can_write_cabinet(r.cabinet_id) or not private.reads_document(r.created_by, r.readers))
    );
$$;

commit;
