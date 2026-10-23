-- Doses (`docs/TASKS.md` F3.7–F3.10): a plan of when a medicine is taken,
-- for a person, and the answer to each dose it asks for.
--
-- A plan is in its product's cabinet, as a box is (migration 2), so a
-- household reads the plans of the household's medicines, and a carer reads
-- whether a dose was taken (F3.9) by the cabinet's own policies; a plan kept
-- to oneself is in one's own cabinet. An answer is in its plan's cabinet. Its
-- id is a hash of the plan and the dose (`src/db/ids.ts`), so two devices
-- answering one dose meet one row and the later answer stands.
--
-- A plan's days and times are the person's local ones, `date` and `HH:MM`,
-- as a box's days are: a dose at 08:00 is at 08:00 wherever the phone is.
-- The server stores and checks them; it never computes a dose.

begin;

create table public.dose_plans (
  cabinet_id uuid not null references public.cabinets (id) on delete cascade,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  tombstone_version bigint not null default 0 check (tombstone_version between 0 and 9007199254740991),
  product_id uuid not null,
  -- The box its doses come out of, which may be in another cabinet.
  package_id uuid,
  person_id uuid,
  -- Thousandths of the box's unit, as a move's.
  amount_milli integer not null check (amount_milli between 1 and 1000000000),
  -- One to eight times of day, a JSON array, earliest first.
  times text not null check (times ~ '^\["([01][0-9]|2[0-3]):[0-5][0-9]"(,"([01][0-9]|2[0-3]):[0-5][0-9]"){0,7}\]$'),
  -- Monday 1, Tuesday 2 … Sunday 64.
  weekdays integer not null check (weekdays between 1 and 127),
  starts_on date not null,
  ends_on date check (ends_on >= starts_on),
  instructions text check (char_length(instructions) <= 500),
  paused boolean not null default false,
  created_by uuid,
  primary key (cabinet_id, id)
);

create table public.dose_logs (
  cabinet_id uuid not null references public.cabinets (id) on delete cascade,
  id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  tombstone_version bigint not null default 0 check (tombstone_version between 0 and 9007199254740991),
  plan_id uuid not null,
  due_on date not null,
  due_time text not null check (due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  status text not null check (status in ('taken', 'skipped', 'snoozed', 'missed')),
  snoozed_until timestamptz check (snoozed_until is null or status = 'snoozed'),
  -- The move a dose taken made in its plan's box.
  move_id uuid,
  answered_by uuid,
  primary key (cabinet_id, id)
);

create index dose_logs_plan on public.dose_logs (plan_id);

do $$
declare
  t text;
begin
  foreach t in array array['dose_plans', 'dose_logs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (private.can_read_cabinet(cabinet_id))',
      t || '_select', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (private.can_write_cabinet(cabinet_id))',
      t || '_insert', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (private.can_write_cabinet(cabinet_id)) with check (private.can_write_cabinet(cabinet_id))',
      t || '_update', t);
    execute format('create index %I on public.%I (updated_at, id)', t || '_pull', t);
    execute format(
      'create trigger set_updated_at before insert or update on public.%I for each row execute function public.set_updated_at()', t);
    execute format(
      'create trigger nudge_cabinet_insert after insert on public.%I referencing new table as new_rows
         for each statement execute function private.nudge_cabinet()', t);
    execute format(
      'create trigger nudge_cabinet_update after update on public.%I referencing new table as new_rows
         for each statement execute function private.nudge_cabinet()', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select, insert, update on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

-- Who planned it, as a document's adder (migration 14).
create trigger stamp_writer before insert or update on public.dose_plans
  for each row execute function private.stamp_writer();

-- Who answered last: unlike a move's writer, a dose answered again is the
-- answer of whoever answered it again, and a carer reads that. Named to run
-- before `set_updated_at` (triggers fire by name): a stale write that one
-- answers with the stored row must not leave the stale writer's name on it.
create function private.stamp_answerer()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.answered_by := (select auth.uid());
  return new;
end;
$$;
revoke all on function private.stamp_answerer() from public, anon, authenticated;

create trigger answer_stamp before insert or update on public.dose_logs
  for each row execute function private.stamp_answerer();

-- Migration 14's, and the two tables.
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
  select 'documents'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.documents h order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'document_links'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.document_links h order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'dose_plans'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.dose_plans h order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'dose_logs'::text, k.updated_at, k.id from (select 1) probe
    left join lateral (select h.updated_at, h.id from public.dose_logs h order by h.updated_at desc, h.id desc limit 1) k on true
  union all
  select 'offers'::text, null::timestamptz, (select private.my_offers());
$$;

commit;
