-- A household's photo (`docs/TASKS.md` F2.3), on its `cabinets` row as a
-- person's is on theirs: set by the owner, the only one who updates the row
-- (migration 5), and seen by every member. The photo functions of migration 2
-- learn the fourth table that names a photo; nothing else about a photo
-- changes. The personal cabinet is given none by the app, and nothing here
-- needs it to.

begin;

alter table public.cabinets add column photo_id uuid;

create trigger forget_unseen_photo before insert or update on public.cabinets
  for each row execute function private.forget_unseen_photo();

-- As the reader: the cabinets policy already shows a household to its owner and members.
create or replace function private.can_see_photo(photo uuid)
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
    or exists (select 1 from public.cabinets r where r.photo_id = photo)
  );
$$;

-- A household's photo is its owner's to place, as its row is theirs to change.
create or replace function private.can_place_photo(photo uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select photo is not null
    and not exists (select 1 from public.people r where r.photo_id = photo and not private.can_write_cabinet(r.cabinet_id))
    and not exists (select 1 from public.products r where r.photo_id = photo and not private.can_write_cabinet(r.cabinet_id))
    and not exists (select 1 from public.packages r where r.photo_id = photo and not private.can_write_cabinet(r.cabinet_id))
    and not exists (select 1 from public.cabinets r where r.photo_id = photo and r.owner_id is distinct from (select auth.uid()));
$$;

create or replace function definers.unnamed_photos()
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
     and not exists (select 1 from public.packages r where r.photo_id = private.photo_of_object(o.name) and r.deleted_at is null)
     and not exists (select 1 from public.cabinets r where r.photo_id = private.photo_of_object(o.name) and r.deleted_at is null);
$$;

commit;
