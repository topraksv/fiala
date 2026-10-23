-- Invitations into a household (`docs/TASKS.md` F2.2): Gital's links and
-- offers (its migrations 5, 12, 13 and 19), with the cabinet as the list.
-- Only the server adds a member, so every way in is a definer here, in the
-- unexposed `definers` schema, behind an invoker of the same name in `public`.
--
-- A link carries a token of 256 random bits, returned once and stored only as
-- its SHA-256; it works once, for seven days. An offer asks, in the app, a
-- person the owner already shares a live household with, so no account is
-- looked up by anything else; it waits until answered, and one declined is
-- deleted, leaving no record. A row is one or the other: exactly one of
-- `token_hash` and `invitee` is set.
--
-- The personal cabinet is never shared: its id is its account's, and every
-- row a device writes before a household names it (`docs/ARCHITECTURE.md` "A
-- cabinet scopes every medicine row"). Rejected: Gital's household made on
-- the first invitation, which there turns the person's own Kiler into it;
-- here a household is a cabinet of its own, made on a device (migration 5).
--
-- Way back: nothing reads these rows but the functions below, so dropping
-- them and the table undoes this; the members they admitted stay members.
begin;

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------

create table public.cabinet_invites (
  id uuid primary key default gen_random_uuid(),
  token_hash text unique,
  invitee uuid references auth.users (id) on delete cascade,
  cabinet_id uuid not null references public.cabinets (id) on delete cascade,
  role text not null check (role in ('editor', 'viewer')),
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check ((token_hash is null) <> (invitee is null))
);
-- One offer a person a cabinet. Invitee first: the account's delete cascades
-- on it and every read asks "offers to me".
create unique index cabinet_invites_offer on public.cabinet_invites (invitee, cabinet_id) where invitee is not null;
create index cabinet_invites_cabinet on public.cabinet_invites (cabinet_id);
create index cabinet_invites_created_by on public.cabinet_invites (created_by);

alter table public.cabinet_invites enable row level security;
revoke all on table public.cabinet_invites from anon, authenticated;
grant all on table public.cabinet_invites to service_role;
-- Reached through the definers alone; a policy refusing client roles says so.
create policy cabinet_invites_no_client on public.cabinet_invites
  as restrictive for all to anon, authenticated
  using (false) with check (false);

-- The owner's household, made ready to share: refused for the personal
-- cabinet, for one the caller does not own, and for one the server does not
-- hold yet (the device sends it and asks again). The owner's own member row
-- gives the household's members the name the owner goes by there.
create function private.open_to_share(cabinet uuid, owner_name text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
begin
  if not exists (select 1 from public.cabinets c where c.id = cabinet and c.owner_id = me and c.deleted_at is null) then
    raise insufficient_privilege using message = 'not the owner of this cabinet';
  end if;
  if cabinet = me then
    raise exception 'the personal cabinet is not shared' using errcode = 'FA001';
  end if;
  insert into public.cabinet_members (cabinet_id, user_id, role, name)
  values (cabinet, me, 'owner', pg_catalog.left(coalesce(owner_name, ''), 60))
  on conflict (cabinet_id, user_id) do nothing;
end;
$$;

-- Being let in, by a link or an offer. It answers any offer to the same
-- cabinet, so none is ever addressed to a member; a member removed comes back
-- only this way.
create function private.admit(cabinet uuid, member_role text, member_name text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
begin
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

create function private.token_hash(token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(token, ''), 'UTF8')), 'hex');
$$;

-- The owner's link for one person, who joins as `invite_role`. Each call
-- clears the owner's expired links.
create function definers.create_cabinet_invite(cabinet uuid, invite_role text, owner_name text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  token text := pg_catalog.replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if invite_role is null or invite_role not in ('editor', 'viewer') then
    raise invalid_parameter_value using message = 'invalid role';
  end if;
  perform private.open_to_share(cabinet, owner_name);
  delete from public.cabinet_invites where created_by = me and expires_at < now();
  insert into public.cabinet_invites (token_hash, cabinet_id, role, created_by, expires_at)
  values (private.token_hash(token), cabinet, invite_role, me, now() + interval '7 days');
  return token;
end;
$$;

-- The owner takes back every link to a household not yet used. Offers are
-- withdrawn one person at a time, by `offer_cabinet` with no role.
create function definers.cancel_cabinet_invites(cabinet uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  taken integer;
begin
  delete from public.cabinet_invites i
   using public.cabinets c
   where i.cabinet_id = cabinet and i.token_hash is not null and c.id = i.cabinet_id and c.owner_id = (select auth.uid());
  get diagnostics taken = row_count;
  return taken;
end;
$$;

-- What a link opens and who sent it, so the page can say so before anyone
-- presses anything. The token is not spent.
create function definers.peek_cabinet_invite(token text)
returns table (name text, inviter text, role text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.name, coalesce(o.name, ''), i.role
    from public.cabinet_invites i
    join public.cabinets c on c.id = i.cabinet_id and c.deleted_at is null
    left join public.cabinet_members o on o.cabinet_id = c.id and o.user_id = c.owner_id
   where i.token_hash = private.token_hash(token)
     and i.expires_at >= now();
$$;

-- Joining by a link: the household's id, or an error that says why not. The
-- token is spent whether or not it was still good.
create function definers.accept_cabinet_invite(token text, member_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  invite public.cabinet_invites;
begin
  delete from public.cabinet_invites i
   where i.token_hash = private.token_hash(token)
  returning * into invite;
  if invite is null or invite.expires_at < now()
     or not exists (select 1 from public.cabinets c where c.id = invite.cabinet_id and c.deleted_at is null) then
    raise invalid_parameter_value using message = 'invite not found';
  end if;
  perform private.admit(invite.cabinet_id, invite.role, member_name);
  return invite.cabinet_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Offers
-- ---------------------------------------------------------------------------

-- The owner offers `cabinet` to `person` as `role`, or withdraws with no
-- role. Offering again changes the role. The two refusals a person's screen
-- can meet have codes of their own (FA002 one already in, whose row has not
-- synced yet; FA003 one who shares no household with the owner), so the app
-- says which instead of a link's "used or expired". An offer has no expiry;
-- `infinity` keeps every comparison on `expires_at` as it is.
create function definers.offer_cabinet(cabinet uuid, person uuid, role text, owner_name text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
begin
  if offer_cabinet.role is null then
    delete from public.cabinet_invites i
     using public.cabinets c
     where i.cabinet_id = cabinet and i.invitee = person and c.id = i.cabinet_id and c.owner_id = me;
    return;
  end if;
  if offer_cabinet.role not in ('editor', 'viewer') then
    raise invalid_parameter_value using message = 'invalid role';
  end if;
  perform private.open_to_share(cabinet, owner_name);
  if person is null or person = me then
    raise invalid_parameter_value using message = 'an offer is to someone else';
  end if;
  if exists (select 1 from public.cabinet_members m where m.cabinet_id = cabinet and m.user_id = person and m.deleted_at is null) then
    raise exception 'already in this cabinet' using errcode = 'FA002';
  end if;
  if not exists (
    select 1
      from public.cabinet_members theirs
      join public.cabinet_members mine on mine.cabinet_id = theirs.cabinet_id and mine.user_id = me and mine.deleted_at is null
      join public.cabinets c on c.id = theirs.cabinet_id and c.deleted_at is null
     where theirs.user_id = person and theirs.deleted_at is null
  ) then
    raise exception 'shares no household with you' using errcode = 'FA003';
  end if;
  insert into public.cabinet_invites (cabinet_id, role, created_by, expires_at, invitee)
  values (cabinet, offer_cabinet.role, me, 'infinity', person)
  on conflict (invitee, cabinet_id) where invitee is not null do update set role = excluded.role;
end;
$$;

-- The offers made to this person and by them, on households still live. The
-- sender's name is the one the owner goes by among the household's members.
create function definers.cabinet_offers()
returns table (cabinet_id uuid, cabinet_name text, role text, from_name text, to_user uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select i.cabinet_id, c.name, i.role, coalesce(o.name, ''), i.invitee
    from public.cabinet_invites i
    join public.cabinets c on c.id = i.cabinet_id and c.deleted_at is null
    left join public.cabinet_members o on o.cabinet_id = c.id and o.user_id = c.owner_id
   where i.invitee is not null
     and (i.invitee = (select auth.uid()) or i.created_by = (select auth.uid()))
   order by i.created_at, i.id;
$$;

-- Accept, and the household's id comes back; decline, and the offer is
-- deleted. A refusal rolls back the whole call, so the offer waits.
create function definers.answer_cabinet_offer(cabinet uuid, accept boolean, member_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  offered public.cabinet_invites;
begin
  if accept is null then
    raise invalid_parameter_value using message = 'accept or decline';
  end if;
  delete from public.cabinet_invites i
   where i.cabinet_id = cabinet and i.invitee = me
  returning * into offered;
  if not found then
    raise invalid_parameter_value using message = 'offer not found';
  end if;
  if not accept then
    return null;
  end if;
  if not exists (select 1 from public.cabinets c where c.id = cabinet and c.deleted_at is null) then
    raise invalid_parameter_value using message = 'offer not found';
  end if;
  perform private.admit(cabinet, offered.role, member_name);
  return cabinet;
end;
$$;

-- ---------------------------------------------------------------------------
-- The change probe says when the offers to a person change
-- ---------------------------------------------------------------------------

-- A hash of the offers to this person, on live households, with what an offer
-- shows: one made, re-made at another role, withdrawn, answered, or left
-- behind by a deleted household each changes it, and so does renaming the
-- household or the owner's name in it. Null when none waits. As the
-- function's owner, since nobody signed in reads `cabinet_invites`.
create function private.my_offers()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.md5(pg_catalog.string_agg(
           pg_catalog.concat_ws(':', i.id, i.role, c.name, o.name), ',' order by i.id))::uuid
    from public.cabinet_invites i
    join public.cabinets c on c.id = i.cabinet_id and c.deleted_at is null
    left join public.cabinet_members o on o.cabinet_id = c.id and o.user_id = c.owner_id
   where i.invitee = (select auth.uid());
$$;

-- Migration 5's, and a row `offers`: an id and no time, which a client before
-- this one skips.
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
  select 'offers'::text, null::timestamptz, (select private.my_offers());
$$;

-- ---------------------------------------------------------------------------
-- The client's API: an invoker in `public` for each definer
-- ---------------------------------------------------------------------------

create function public.create_cabinet_invite(cabinet uuid, invite_role text, owner_name text)
returns text language sql security invoker set search_path = ''
as $$ select definers.create_cabinet_invite($1, $2, $3) $$;

create function public.cancel_cabinet_invites(cabinet uuid)
returns integer language sql security invoker set search_path = ''
as $$ select definers.cancel_cabinet_invites($1) $$;

create function public.peek_cabinet_invite(token text)
returns table (name text, inviter text, role text)
language sql stable security invoker set search_path = ''
as $$ select * from definers.peek_cabinet_invite($1) $$;

create function public.accept_cabinet_invite(token text, member_name text)
returns uuid language sql security invoker set search_path = ''
as $$ select definers.accept_cabinet_invite($1, $2) $$;

create function public.offer_cabinet(cabinet uuid, person uuid, role text, owner_name text)
returns void language sql security invoker set search_path = ''
as $$ select definers.offer_cabinet($1, $2, $3, $4) $$;

create function public.cabinet_offers()
returns table (cabinet_id uuid, cabinet_name text, role text, from_name text, to_user uuid)
language sql stable security invoker set search_path = ''
as $$ select * from definers.cabinet_offers() $$;

create function public.answer_cabinet_offer(cabinet uuid, accept boolean, member_name text)
returns uuid language sql security invoker set search_path = ''
as $$ select definers.answer_cabinet_offer($1, $2, $3) $$;

-- `private` and `definers` have no default privileges, so a new function
-- there is anyone's until revoked; `public`'s withhold execute (migration 1)
-- until granted.
revoke all on function private.open_to_share(uuid, text) from public, anon, authenticated;
revoke all on function private.admit(uuid, text, text) from public, anon, authenticated;
revoke all on function private.token_hash(text) from public, anon, authenticated;
revoke all on function private.my_offers() from public, anon;
grant execute on function private.my_offers() to authenticated;

revoke all on function definers.create_cabinet_invite(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function definers.cancel_cabinet_invites(uuid) from public, anon, authenticated, service_role;
revoke all on function definers.peek_cabinet_invite(text) from public, anon, authenticated, service_role;
revoke all on function definers.accept_cabinet_invite(text, text) from public, anon, authenticated, service_role;
revoke all on function definers.offer_cabinet(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function definers.cabinet_offers() from public, anon, authenticated, service_role;
revoke all on function definers.answer_cabinet_offer(uuid, boolean, text) from public, anon, authenticated, service_role;
grant execute on function definers.create_cabinet_invite(uuid, text, text) to authenticated;
grant execute on function definers.cancel_cabinet_invites(uuid) to authenticated;
grant execute on function definers.peek_cabinet_invite(text) to authenticated;
grant execute on function definers.accept_cabinet_invite(text, text) to authenticated;
grant execute on function definers.offer_cabinet(uuid, uuid, text, text) to authenticated;
grant execute on function definers.cabinet_offers() to authenticated;
grant execute on function definers.answer_cabinet_offer(uuid, boolean, text) to authenticated;

revoke all on function public.create_cabinet_invite(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.cancel_cabinet_invites(uuid) from public, anon, authenticated, service_role;
revoke all on function public.peek_cabinet_invite(text) from public, anon, authenticated, service_role;
revoke all on function public.accept_cabinet_invite(text, text) from public, anon, authenticated, service_role;
revoke all on function public.offer_cabinet(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.cabinet_offers() from public, anon, authenticated, service_role;
revoke all on function public.answer_cabinet_offer(uuid, boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.create_cabinet_invite(uuid, text, text) to authenticated;
grant execute on function public.cancel_cabinet_invites(uuid) to authenticated;
grant execute on function public.peek_cabinet_invite(text) to authenticated;
grant execute on function public.accept_cabinet_invite(text, text) to authenticated;
grant execute on function public.offer_cabinet(uuid, uuid, text, text) to authenticated;
grant execute on function public.cabinet_offers() to authenticated;
grant execute on function public.answer_cabinet_offer(uuid, boolean, text) to authenticated;

commit;
