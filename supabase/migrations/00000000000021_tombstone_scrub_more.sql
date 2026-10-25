-- What migration 20 left with words (the 0.2.0 review, docs/BACKLOG.md):
--
-- A place's name, scrubbed now as a tag's is; `scrubTombstone` blanks it on
-- the device too.
--
-- A deleted box's history. A box's change rows hold its note, nickname and
-- serial before and after; the device now tombstones them with the box, in the
-- write its undo takes back whole. Those of a box deleted before it are
-- tombstoned here, once. Not by a trigger on every box's delete: the server's
-- tombstone would be a generation ahead of the undo's rows, which
-- `set_updated_at` then refuses, and the undo would bring the box back without
-- its history.

begin;

alter table public.locations drop constraint locations_name_check,
  add constraint locations_name_check check (char_length(name) between 1 and 80 or (deleted_at is not null and name = ''));

create or replace function private.tombstone_scrub()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.deleted_at is null then
    return new;
  end if;
  case tg_table_name
    when 'people' then
      new.name := ''; new.color := null; new.warn_days := null;
      new.allergies := null; new.conditions := null;
    when 'products' then
      new.name := ''; new.brand := null; new.active_substance := null; new.strength := null; new.form := null;
      new.pack := null; new.manufacturer := null; new.gtin := null; new.note := null;
      new.starred := false; new.wanted := false;
    when 'tags', 'locations' then
      new.name := '';
    when 'packages' then
      new.person_id := null; new.location_id := null; new.expires_on := null; new.opened_on := null;
      new.use_within_days := null; new.low_milli := null; new.serial := null; new.lot := null;
      new.nickname := null; new.acquired_on := null; new.acquired_from := null; new.note := null;
      new.disposition := null; new.warn_days := null;
      new.check_of := null; new.check_asked_at := null;
    when 'package_changes' then
      new.changes := '{}';
    when 'documents' then
      new.title := ''; new.person_id := null; new.issued_on := null; new.note := null;
      new.reference := null;
    when 'dose_plans' then
      new.instructions := null;
  end case;
  return new;
end;
$$;
revoke all on function private.tombstone_scrub() from public, anon, authenticated;

create trigger tombstone_scrub before insert or update on public.locations
  for each row execute function private.tombstone_scrub();
update public.locations set deleted_at = deleted_at where deleted_at is not null;

update public.package_changes c set deleted_at = pg_catalog.now()
  from public.packages p
  where p.cabinet_id = c.cabinet_id and p.id = c.package_id
    and p.deleted_at is not null and c.deleted_at is null;

commit;
