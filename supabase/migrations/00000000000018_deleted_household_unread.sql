-- A deleted household's rows leave the server's reads, not only the device's.
-- Until now its tombstone was on its `cabinets` row alone and every other row
-- stayed readable to its members, so a device signed in during the delete
-- downloaded a household's health data only to forget it (docs/PRIVACY.md).
--
-- `can_read_cabinet`, which every child table's policy and the Storage reads
-- through them call, now asks that the cabinet be live. Three reads must still
-- see a deleted household: the `cabinets` row itself and its members, which
-- tell a device of the delete and of the undo on its next pull, and its
-- realtime channel, so a device already listening hears the delete at once
-- (it stops listening then, and hears the undo by the pull). They ask
-- `in_cabinet`, the membership alone. `can_write_cabinet` refuses a write into
-- a deleted household; the undo is the owner's update of the `cabinets` row,
-- which asks only `owner_id`.
--
-- A restore changes no child row, so no cursor brings them back: the device
-- refetches the household whole, keyed on the cabinet's delete generation
-- (`followMemberships`, src/sync/engine.ts).

begin;

create function private.in_cabinet(cabinet uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.cabinets c where c.id = cabinet and c.owner_id = (select auth.uid()))
      or exists (
        select 1 from public.cabinet_members m
         where m.cabinet_id = cabinet and m.user_id = (select auth.uid()) and m.deleted_at is null
      );
$$;
revoke all on function private.in_cabinet(uuid) from public, anon;
grant execute on function private.in_cabinet(uuid) to authenticated, service_role;

create or replace function private.can_read_cabinet(cabinet uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.cabinets c where c.id = cabinet and c.deleted_at is null)
     and private.in_cabinet(cabinet);
$$;

create or replace function private.can_write_cabinet(cabinet uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.cabinets c
     where c.id = cabinet and c.deleted_at is null
       and (c.owner_id = (select auth.uid())
            or exists (
              select 1 from public.cabinet_members m
               where m.cabinet_id = cabinet and m.user_id = (select auth.uid()) and m.deleted_at is null and m.role = 'editor'
            ))
  );
$$;

drop policy cabinets_select on public.cabinets;
create policy cabinets_select on public.cabinets for select to authenticated
  using (owner_id = (select auth.uid()) or private.in_cabinet(id));

drop policy cabinet_members_select on public.cabinet_members;
-- A person always sees their own rows, so a device learns it was removed.
create policy cabinet_members_select on public.cabinet_members for select to authenticated
  using (user_id = (select auth.uid()) or private.in_cabinet(cabinet_id));

drop policy cabinet_channel_hear on realtime.messages;
create policy cabinet_channel_hear on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and private.in_cabinet(private.cabinet_of_topic((select realtime.topic())))
  );

commit;
