-- A row stays in the cabinet it was made in. The update policies ask only that
-- the caller can write both the old cabinet and the new, so an editor of a
-- household could send their own cabinet's id and carry a medicine, a document
-- or a dose plan out of it with no tombstone: the owner's devices were never
-- told, and a fresh install never saw the row (devil round 2026-11-03-1; Gital's
-- `keep_row_list` closed the same hole). The app never moves a row in place —
-- `moveBox` and `moveDocument` write a new row there and a tombstone here — so
-- pinning the column costs nothing a device sends.
create function private.keep_row_cabinet()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' then
    new.cabinet_id := old.cabinet_id;
  end if;
  return new;
end;
$$;

revoke all on function private.keep_row_cabinet() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'people', 'locations', 'products', 'packages', 'package_moves', 'package_changes',
    'tags', 'product_tags', 'documents', 'document_links', 'dose_plans', 'dose_logs'
  ] loop
    execute format(
      'create trigger keep_row_cabinet before update of cabinet_id on public.%I for each row execute function private.keep_row_cabinet()',
      t);
  end loop;
end;
$$;
