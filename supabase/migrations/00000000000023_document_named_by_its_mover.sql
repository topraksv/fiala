-- A new row may name a household document's file only for whom the app lets
-- move it (`movableBy`, src/data/documents.ts): whoever added a row naming it,
-- or anyone whose own cabinet holds one. The uploader may always. A row with no
-- adder gives no one the right: on the server that means a row written without
-- a session, never a member's. Until now reading the file was enough, so an editor
-- could copy a household document into their own cabinet; once the household
-- deleted it and removed them, that row still read the file and kept it from
-- the sweep (devil finding 202b46457c5b).
--
-- Photos keep the old rule: `moveBox` lets any editor carry a box and its photo
-- out of a household, so a photo has no mover to ask for.
--
-- Rows already copied this way are left as they are: the app never writes
-- one, so only a hand-made request could have.

begin;

-- As definer, so every row naming the file is seen; `can_read_cabinet` keeps
-- it to rows the writer can read.
create function private.may_name_document(file uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1 from storage.objects o
       where o.bucket_id = 'documents'
         and private.document_of_object(o.name) = file
         and o.owner_id = (select auth.uid())::text
    )
    or exists (
      select 1 from public.documents r
       where r.file_id = file
         and private.can_read_cabinet(r.cabinet_id)
         and (r.cabinet_id = (select auth.uid()) or r.created_by = (select auth.uid()))
    );
$$;

create or replace function private.forget_unseen_document()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated'
     and new.file_id is not null
     and (tg_op = 'INSERT' or new.file_id is distinct from old.file_id)
     and private.document_stored(new.file_id)
     and (
       not exists (
         select 1 from storage.objects o
          where o.bucket_id = 'documents' and private.document_of_object(o.name) = new.file_id
       )
       or not private.may_name_document(new.file_id)
     ) then
    new.file_id := null;
    new.file_type := null;
    new.byte_size := null;
  end if;
  return new;
end;
$$;

revoke all on function private.may_name_document(uuid) from public, anon;
grant execute on function private.may_name_document(uuid) to authenticated;

commit;
