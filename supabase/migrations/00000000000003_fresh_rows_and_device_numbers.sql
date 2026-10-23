-- Two things one copy could do to another, closed where only the server can
-- close them, as Gital's migration 16 closed them for its lists.
--
-- 1. A product made afresh over a live one. A product with a GTIN takes its id
-- from the cabinet and the barcode, so a device that never pulled the
-- server's row makes its own under the same id, and its push replaced that
-- row whole: a second phone scanning the same box cleared the note, the star,
-- the to-buy mark and the photo, which the unnamed-photo sweep then deleted.
-- A fresh row is told by its `created_at`, which a device keeps from the row
-- it pulled; meeting a live row, what it says still wins, but its nulls and
-- its falses blank nothing it never saw — unlike Gital's, Fiala's flags are
-- `not null default false`, so a false there means untouched. The row keeps
-- the day it was first made. A device may write one on purpose to revive a
-- row a reset it missed took (`isAddedAgain`), which meets a tombstone and is
-- left alone. Rejected: refusing the write, which would hold that device's
-- outbox for good.
create or replace function private.keep_live_values()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated'
     and old.deleted_at is null and new.deleted_at is null
     -- To the millisecond, as a device holds it.
     and pg_catalog.date_trunc('milliseconds', new.created_at)
         is distinct from pg_catalog.date_trunc('milliseconds', old.created_at) then
    new := pg_catalog.jsonb_populate_record(old, (
      select coalesce(pg_catalog.jsonb_object_agg(field.key, field.value), '{}'::jsonb)
        from pg_catalog.jsonb_each(pg_catalog.to_jsonb(new)) as field
       where field.value not in ('null'::jsonb, 'false'::jsonb)
    ));
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

revoke all on function private.keep_live_values() from public, anon;

-- Before `set_updated_at`, which then stamps the merged row; triggers run by name.
create trigger keep_live_values before update on public.products
  for each row execute function private.keep_live_values();

-- 2. A number no device can hold. The app keeps every synced integer as a
-- JavaScript number, and a pull refuses a whole page holding one past 2^53 so
-- that nothing lands behind a cursor that moved past it: one such row would
-- stop that table's pull for good, for every member once a cabinet is shared.
-- The device cannot skip it without losing it, so the server stops taking it,
-- in every bigint column the app syncs.
do $$
declare
  c record;
begin
  for c in
    select table_name, column_name from information_schema.columns
     where table_schema = 'public' and data_type = 'bigint'
       and table_name in ('people', 'locations', 'tags', 'products', 'product_tags',
                          'packages', 'package_moves', 'package_changes', 'settings')
  loop
    execute format(
      'alter table public.%I add constraint %I check (%I between -9007199254740991 and 9007199254740991)',
      c.table_name, c.column_name || '_fits_device', c.column_name);
  end loop;
end;
$$;
