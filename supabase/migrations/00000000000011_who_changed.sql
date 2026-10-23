-- Who changed a box (`docs/TASKS.md` F2.8, F1.21): each move and each edit
-- names the account that wrote it, so a household's history says who did
-- what. The server stamps it from the request's own token when the row is
-- first written, and nothing changes it after; a device's value is never
-- taken, so no member can write in another's name. A box moved to another
-- cabinet (F2.5) is written afresh there, and its copied history is then the
-- mover's. Rows written before this have no writer, and say none.

begin;

alter table public.package_moves add column created_by uuid;
alter table public.package_changes add column created_by uuid;

create function private.stamp_writer()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
  else
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;
revoke all on function private.stamp_writer() from public, anon, authenticated;

create trigger stamp_writer before insert or update on public.package_moves
  for each row execute function private.stamp_writer();
create trigger stamp_writer before insert or update on public.package_changes
  for each row execute function private.stamp_writer();

commit;
