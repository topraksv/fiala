-- Two holes the pre-push review of migrations 4 and 6 found.
--
-- A cabinet has one owner. Migration 4's guard let the owner's device raise a
-- member to `owner`, and the guard then held that member as it holds the
-- owner: unable to leave, unable to be removed.
--
-- Joining a household raced its deletion: `admit` read the cabinet as live
-- without a lock, so a deletion committing in between let the member in. It
-- now holds the cabinet's row for share, which a deletion's update waits on.
--
-- Two sentences of migration 6 were wrong and stay so there: a link's token is
-- two random UUIDs, 244 random bits, not 256; and a refused link is not spent,
-- since the refusal rolls the delete back. An expired one goes with its
-- owner's next link.

begin;

create or replace function private.guard_cabinet_member()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  is_owner boolean := private.is_cabinet_owner(old.cabinet_id);
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  new.cabinet_id := old.cabinet_id;
  new.user_id := old.user_id;
  if old.role = 'owner' then
    -- The owner neither leaves nor is demoted: a cabinet without one has nobody to manage it.
    new.role := 'owner';
    new.deleted_at := old.deleted_at;
    new.tombstone_version := old.tombstone_version;
  elsif not is_owner or new.role = 'owner' then
    new.role := old.role;
  end if;
  if old.deleted_at is not null then
    -- Back in only by a new invitation.
    new.deleted_at := old.deleted_at;
    new.tombstone_version := old.tombstone_version;
  end if;
  if old.user_id <> (select auth.uid()) then
    new.name := old.name;
    new.seen_at := old.seen_at;
  end if;
  return new;
end;
$$;

create or replace function private.admit(cabinet uuid, member_role text, member_name text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
begin
  perform 1 from public.cabinets c where c.id = cabinet and c.deleted_at is null for share;
  if not found then
    raise invalid_parameter_value using message = 'invite not found';
  end if;
  delete from public.cabinet_invites i where i.cabinet_id = cabinet and i.invitee = me;
  if exists (select 1 from public.cabinets c where c.id = cabinet and c.owner_id = me) then
    return;
  end if;
  insert into public.cabinet_members (cabinet_id, user_id, role, name)
  values (cabinet, me, member_role, pg_catalog.left(coalesce(member_name, ''), 60))
  on conflict (cabinet_id, user_id) do update
    set role = excluded.role, name = excluded.name, deleted_at = null;
end;
$$;

commit;
