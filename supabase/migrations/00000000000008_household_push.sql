-- A device pushes a new household as PostgREST upserts it: an insert that
-- returns the row, so the row must pass the select policy in the statement
-- that inserts it. Migration 4 made that policy `can_read_cabinet(id)`, whose
-- lookup of `cabinets` runs on the statement's snapshot and cannot see the row
-- being inserted, so every household a device opened was refused (42501) and
-- never reached the server. Gital met the same with its lists (its migration
-- 8). The owner's own row is now recognised on the row itself, before the
-- lookup that serves members.

begin;

drop policy cabinets_select on public.cabinets;
create policy cabinets_select on public.cabinets for select to authenticated
  using (owner_id = (select auth.uid()) or private.can_read_cabinet(id));

commit;
