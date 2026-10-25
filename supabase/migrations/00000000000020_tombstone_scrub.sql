-- A tombstone keeps nothing a person typed or chose (KVKK m. 7, docs/TASKS.md
-- F7.11). Until now a deleted box, medicine, person, tag, history entry or
-- dose plan carried its content on the server until the account was deleted,
-- and a reset left the whole cabinet's words there.
--
-- `tombstone_scrub` blanks a row's content whenever its `deleted_at` is set,
-- the same columns `scrubTombstone` (src/db/mutations.ts) blanks on the
-- device, so the answer to a push is the row the device wrote and an undo
-- still matches it; the undo carries the content back from the device's own
-- snapshot. The trigger is needed even so: a device leaves a column out of a
-- push when it holds its empty value, and the server would keep what it had.
--
-- What stays: ids, the cabinet, the parent each row names (a deleted plan's
-- product and person are read for its answers' names), the stamps, what a
-- check needs (a box's unit, a plan's times and amount), and a photo's or a
-- file's id: `forget_unseen_photo` and `forget_unseen_document` let a row name
-- a file only while a row the writer can read names it, so a household
-- member's undo would lose a file another member sent. Only a live row
-- authorises a file or keeps it from the sweep, so the id grants nothing.
-- Moves, settings, households, members and links hold no words, or a revive
-- reads them back, and are left whole. A name may be '' on a tombstone alone.
--
-- Triggers run by name: after `set_updated_at`, which may hand back the old
-- row to a client behind on its generations, and after `forget_unseen_photo`,
-- `keep_live_values` and `stamp_writer`, so nothing writes a column back.
--
-- Not reached here, said in docs/PRIVACY.md: a product's id is a hash of its
-- cabinet and GTIN, a dose answer's of its plan, day and time; a deleted
-- household's rows stay as they were; a file's bytes wait for the sweep.

begin;

alter table public.people drop constraint people_name_check,
  add constraint people_name_check check (char_length(name) between 1 and 80 or (deleted_at is not null and name = ''));
alter table public.products drop constraint products_name_check,
  add constraint products_name_check check (char_length(name) between 1 and 200 or (deleted_at is not null and name = ''));
alter table public.tags drop constraint tags_name_check,
  add constraint tags_name_check check (char_length(name) between 1 and 80 or (deleted_at is not null and name = ''));

create function private.tombstone_scrub()
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
    when 'tags' then
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

do $$
declare
  t text;
begin
  foreach t in array array['people', 'products', 'tags', 'packages', 'package_changes', 'documents', 'dose_plans'] loop
    execute format('create trigger tombstone_scrub before insert or update on public.%I for each row execute function private.tombstone_scrub()', t);
    -- The tombstones already there, scrubbed by the trigger itself; their new
    -- `updated_at` takes the blank rows to every device on its next pull.
    execute format('update public.%I set deleted_at = deleted_at where deleted_at is not null', t);
  end loop;
end;
$$;

commit;
