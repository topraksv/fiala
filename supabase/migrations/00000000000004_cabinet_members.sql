-- Membership (`docs/TASKS.md` F2.1): a cabinet has members, and the two
-- helpers every cabinet policy calls now ask "is this one of my cabinets"
-- instead of "is this my account" (`docs/ARCHITECTURE.md` "A cabinet scopes
-- every medicine row"). No policy changes. Gital's `list_members` (its
-- migrations 5 and 11), with the cabinet as the list.
--
-- A cabinet is a row now, so a shared one can exist beside the account's. The
-- personal cabinet keeps its id, the account's: the server makes it when the
-- account is made, and for every account already here, so no device writes a
-- cabinet and none can claim another account's id. Rejected: a device pushing
-- its own cabinet row, which lets one account make a cabinet under another's
-- id before that account's device does.
--
-- A member row is made only by the server (an invitation, F2.2). What a
-- device writes back is guarded as Gital's is: a member may change their own
-- name and `seen_at`, or leave; the owner may change a role or remove a
-- member; nobody changes the owner's row, and nobody but an invitation brings
-- a removed member back.
--
-- Way back: until an invitation ships every cabinet is personal, so a later
-- migration can point `cabinet_id` at `auth.users` again.

begin;

-- ---------------------------------------------------------------------------
-- Cabinets
-- ---------------------------------------------------------------------------

create table public.cabinets (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  tombstone_version bigint not null default 0 check (tombstone_version between 0 and 9007199254740991)
);
create index cabinets_owner on public.cabinets (owner_id);
create trigger set_updated_at before insert or update on public.cabinets
  for each row execute function public.set_updated_at();

insert into public.cabinets (id, owner_id) select u.id, u.id from auth.users u;

-- Definer: the auth service inserts the account, and holds no right on `public`.
create function private.make_personal_cabinet()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.cabinets (id, owner_id) values (new.id, new.id) on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function private.make_personal_cabinet() from public, anon, authenticated;

create trigger make_personal_cabinet after insert on auth.users
  for each row execute function private.make_personal_cabinet();

-- Deleting the account still takes its cabinet, now through the cabinet row.
do $$
declare
  t text;
begin
  foreach t in array array['people', 'locations', 'products', 'tags', 'product_tags', 'packages', 'package_moves', 'package_changes'] loop
    execute format('alter table public.%I drop constraint %I', t, t || '_cabinet_id_fkey');
    execute format(
      'alter table public.%I add constraint %I foreign key (cabinet_id) references public.cabinets (id) on delete cascade',
      t, t || '_cabinet_id_fkey');
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------------

create table public.cabinet_members (
  id uuid primary key default gen_random_uuid(),
  cabinet_id uuid not null references public.cabinets (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  tombstone_version bigint not null default 0 check (tombstone_version between 0 and 9007199254740991),
  role text not null check (role in ('owner', 'editor', 'viewer')),
  name text not null default '' check (char_length(name) <= 60),
  seen_at timestamptz,
  unique (cabinet_id, user_id)
);
create index cabinet_members_user on public.cabinet_members (user_id);
create index cabinet_members_pull on public.cabinet_members (updated_at, id);
create trigger set_updated_at before insert or update on public.cabinet_members
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Who may read and write a cabinet. Definer from here: the bodies read the
-- cabinet and membership tables, which a caller may not.
-- ---------------------------------------------------------------------------

create or replace function private.can_read_cabinet(cabinet uuid)
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

create or replace function private.can_write_cabinet(cabinet uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.cabinets c where c.id = cabinet and c.owner_id = (select auth.uid()))
      or exists (
        select 1 from public.cabinet_members m
         where m.cabinet_id = cabinet and m.user_id = (select auth.uid()) and m.deleted_at is null and m.role = 'editor'
      );
$$;

create function private.is_cabinet_owner(cabinet uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.cabinets c where c.id = cabinet and c.owner_id = (select auth.uid()));
$$;

-- A device's push is PostgREST's upsert, and Postgres asks INSERT's privilege
-- and INSERT's policy of every upsert, even one that only updates. So the
-- insert is granted and its policy admits only a row the server already
-- holds: the upsert becomes the update below, and nobody writes a member in.
create function private.is_member_row(member uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.cabinet_members m where m.id = member);
$$;

revoke all on function private.is_cabinet_owner(uuid) from public, anon;
revoke all on function private.is_member_row(uuid) from public, anon;
grant execute on function private.is_cabinet_owner(uuid) to authenticated;
grant execute on function private.is_member_row(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Policies: a cabinet is read, never written, by a device
-- ---------------------------------------------------------------------------

alter table public.cabinets enable row level security;
create policy cabinets_select on public.cabinets for select to authenticated
  using (private.can_read_cabinet(id));
revoke all on table public.cabinets from anon, authenticated;
grant select on table public.cabinets to authenticated;
grant all on table public.cabinets to service_role;

alter table public.cabinet_members enable row level security;
-- A person always sees their own rows, so a device learns it was removed.
create policy cabinet_members_select on public.cabinet_members for select to authenticated
  using (user_id = (select auth.uid()) or private.can_read_cabinet(cabinet_id));
create policy cabinet_members_insert on public.cabinet_members for insert to authenticated
  with check (private.is_member_row(id));
create policy cabinet_members_update on public.cabinet_members for update to authenticated
  using (user_id = (select auth.uid()) or private.is_cabinet_owner(cabinet_id))
  with check (user_id = (select auth.uid()) or private.is_cabinet_owner(cabinet_id));
revoke all on table public.cabinet_members from anon, authenticated;
grant select, insert, update on table public.cabinet_members to authenticated;
grant all on table public.cabinet_members to service_role;

-- What a device's write may change. The server's own writes pass untouched.
create function private.guard_cabinet_member()
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
  elsif not is_owner then
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
revoke all on function private.guard_cabinet_member() from public, anon, authenticated;

-- Before `set_updated_at`, which then stamps what the guard left; triggers run by name.
create trigger guard_cabinet_member before update on public.cabinet_members
  for each row execute function private.guard_cabinet_member();

commit;
