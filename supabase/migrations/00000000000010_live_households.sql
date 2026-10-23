-- A shared household, live (`docs/TASKS.md` F2.6), as Gital's lists are
-- (its migrations 6 and 17, `docs/ARCHITECTURE.md` "Live lists hear the
-- server's nudge on a private channel"): a household has a private channel,
-- `cabinet:<id>`, which only its members hear and where nobody speaks. The
-- server says there that the cabinet moved, once per cabinet per statement,
-- and the rows still come by the pull. Each person hears `user:<id>` too, told
-- there when their place in a household changes, since a removed member no
-- longer hears the household's own. A personal cabinet's changes are told
-- nowhere: only its owner reads it, and their devices skip their own push.

begin;

-- The cabinet a channel is for, or null for a topic that names none.
create function private.cabinet_of_topic(topic text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case when topic ~ '^cabinet:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then pg_catalog.substr(topic, 9)::uuid end;
$$;
revoke all on function private.cabinet_of_topic(text) from public, anon;
grant execute on function private.cabinet_of_topic(text) to authenticated;

create policy cabinet_channel_hear on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and private.can_read_cabinet(private.cabinet_of_topic((select realtime.topic())))
  );
create policy user_channel_hear on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) = 'user:' || (select auth.uid())::text
  );

-- The server's word, as its owner: `realtime.send` writes as its caller and
-- swallows a refusal as a warning, and a member may not broadcast. It names
-- who moved the cabinet, so their own devices need not pull what they pushed.
create function private.nudge_cabinet()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  key text := case when tg_table_name = 'cabinets' then 'id' else 'cabinet_id' end;
  cabinet uuid;
begin
  for cabinet in select distinct (pg_catalog.to_jsonb(r) ->> key)::uuid from new_rows r loop
    if exists (select 1 from public.cabinets c where c.id = cabinet and c.id <> c.owner_id) then
      perform realtime.send(pg_catalog.jsonb_build_object('by', auth.uid()), 'moved', 'cabinet:' || cabinet, true);
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function private.nudge_cabinet() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['cabinets', 'cabinet_members', 'people', 'locations', 'products', 'tags', 'product_tags', 'packages', 'package_moves', 'package_changes'] loop
    -- A transition table takes one event a trigger.
    execute pg_catalog.format(
      'create trigger nudge_cabinet_insert after insert on public.%I referencing new table as new_rows
         for each statement execute function private.nudge_cabinet()', t);
    execute pg_catalog.format(
      'create trigger nudge_cabinet_update after update on public.%I referencing new table as new_rows
         for each statement execute function private.nudge_cabinet()', t);
  end loop;
end;
$$;

create function private.tell_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  person uuid;
  cabinet uuid;
begin
  for person, cabinet in
    select n.user_id, n.cabinet_id from new_rows n join old_rows o on o.id = n.id
     where n.deleted_at is distinct from o.deleted_at or n.role is distinct from o.role
  loop
    perform realtime.send(pg_catalog.jsonb_build_object('by', auth.uid(), 'cabinet', cabinet), 'moved', 'user:' || person, true);
  end loop;
  return null;
end;
$$;
revoke all on function private.tell_member() from public, anon, authenticated;

create trigger tell_member after update on public.cabinet_members
  referencing old table as old_rows new table as new_rows
  for each statement execute function private.tell_member();

commit;
