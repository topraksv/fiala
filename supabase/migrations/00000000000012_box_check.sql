-- A member asks another to check a box (`docs/TASKS.md` F2.9): the box names
-- whom, and since when, until one who may write it says it is checked. Two
-- columns of the box rather than a table of asks: one open ask a box is all
-- the page offers, and the box already carries its sync, its rights, its
-- history (who asked is its edit's writer, migration 11) and its household's
-- nudge (migration 10). Expo Go has no remote push, so the one asked sees it
-- in the notification centre at their next pull.

begin;

alter table public.packages
  add column check_of uuid,
  add column check_asked_at timestamptz,
  add constraint packages_check_ask check ((check_of is null) = (check_asked_at is null));

commit;
