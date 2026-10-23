-- Doses (migration 15): who reads a plan and its answers, who may write them,
-- whom the server names as planner and answerer, and what a plan or an answer
-- may hold. Members are fixtures made as postgres, as in `documents.sql`.
begin;

set local role postgres;
set local search_path = extensions, public, pg_catalog;

select extensions.plan(21);

create function pg_temp.exec_sqlstate(command text)
returns text
language plpgsql
as $$
begin
  execute command;
  return null;
exception when others then
  return sqlstate;
end $$;

select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('dose_plans', 'dose_logs')
      and roles = array['authenticated']::name[] and cmd in ('SELECT', 'INSERT', 'UPDATE')),
  6::bigint,
  'each dose table has select, insert and update policies for authenticated'
);
select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('dose_plans', 'dose_logs')
      and (grantee = 'anon' or (grantee = 'authenticated' and privilege_type not in ('SELECT','INSERT','UPDATE')))),
  0::bigint,
  'anon holds nothing on them, and a signed-in request cannot delete'
);
select is(
  (select count(*) from pg_class where oid in ('public.dose_plans'::regclass, 'public.dose_logs'::regclass) and relrowsecurity),
  2::bigint,
  'both have row-level security on'
);
select is(
  has_function_privilege('authenticated', 'private.stamp_answerer()', 'execute'),
  false,
  'no request calls the answerer''s stamp itself'
);

-- A owns the household H, B edits it, C views it, D is outside it.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       'fiala-dose-' || u.n || '@example.invalid', '', now(),
       '{"provider":"email","providers":["email"]}', '{}', now(), now()
  from (values ('a', '10000000-0000-4000-8000-000000000001'::uuid),
               ('b', '20000000-0000-4000-8000-000000000002'::uuid),
               ('c', '30000000-0000-4000-8000-000000000003'::uuid),
               ('d', '40000000-0000-4000-8000-000000000004'::uuid)) as u (n, id);

insert into public.cabinets (id, owner_id, name) values
  ('c0000000-0000-7000-8000-00000000000c', '10000000-0000-4000-8000-000000000001', 'Ev');
insert into public.cabinet_members (cabinet_id, user_id, role, name) values
  ('c0000000-0000-7000-8000-00000000000c', '10000000-0000-4000-8000-000000000001', 'owner', 'Ayşe'),
  ('c0000000-0000-7000-8000-00000000000c', '20000000-0000-4000-8000-000000000002', 'editor', 'Burak'),
  ('c0000000-0000-7000-8000-00000000000c', '30000000-0000-4000-8000-000000000003', 'viewer', 'Can');

-- A's plan in the household, and its morning dose answered.
insert into public.dose_plans (cabinet_id, id, product_id, amount_milli, times, weekdays, starts_on) values
  ('c0000000-0000-7000-8000-00000000000c', 'a1000000-0000-7000-8000-00000000000a', 'b1000000-0000-7000-8000-00000000000b', 1000, '["08:00","20:00"]', 127, '2026-10-19');
insert into public.dose_logs (cabinet_id, id, plan_id, due_on, due_time, status) values
  ('c0000000-0000-7000-8000-00000000000c', 'e1000000-0000-8000-8000-00000000000e', 'a1000000-0000-7000-8000-00000000000a', '2026-10-20', '08:00', 'taken');

-- D, outside.
select set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000004', true);
set local role authenticated;

select is(
  (select count(*) from public.dose_plans) + (select count(*) from public.dose_logs),
  0::bigint,
  'D reads no plan and no answer of a cabinet it is not in'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.dose_logs (cabinet_id, id, plan_id, due_on, due_time, status) values
    ('c0000000-0000-7000-8000-00000000000c', 'e2000000-0000-8000-8000-00000000000e', 'a1000000-0000-7000-8000-00000000000a', '2026-10-20', '20:00', 'taken')$$),
  '42501',
  'nor answers a dose there'
);

-- C, a viewer: a carer who reads whether a dose was taken.
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000003', true);
set local role authenticated;

select is((select status from public.dose_logs), 'taken', 'a viewer reads whether the dose was taken');
select is(
  pg_temp.exec_sqlstate($$insert into public.dose_logs (cabinet_id, id, plan_id, due_on, due_time, status) values
    ('c0000000-0000-7000-8000-00000000000c', 'e2000000-0000-8000-8000-00000000000e', 'a1000000-0000-7000-8000-00000000000a', '2026-10-20', '20:00', 'taken')$$),
  '42501',
  'and answers none'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.dose_plans (cabinet_id, id, product_id, amount_milli, times, weekdays, starts_on) values
    ('c0000000-0000-7000-8000-00000000000c', 'a2000000-0000-7000-8000-00000000000a', 'b1000000-0000-7000-8000-00000000000b', 1000, '["09:00"]', 127, '2026-10-19')$$),
  '42501',
  'nor plans one'
);

-- B, an editor.
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
set local role authenticated;

select lives_ok(
  $$insert into public.dose_plans (cabinet_id, id, product_id, amount_milli, times, weekdays, starts_on, created_by) values
      ('c0000000-0000-7000-8000-00000000000c', 'a2000000-0000-7000-8000-00000000000a', 'b1000000-0000-7000-8000-00000000000b', 500, '["09:00"]', 1, '2026-10-19', '40000000-0000-4000-8000-000000000004');
    update public.dose_logs set status = 'skipped', answered_by = '40000000-0000-4000-8000-000000000004'
     where id = 'e1000000-0000-8000-8000-00000000000e'$$,
  'an editor plans a dose and answers A''s again, each naming D'
);
select is(
  (select array[(select created_by from public.dose_plans where id = 'a2000000-0000-7000-8000-00000000000a'),
                (select answered_by from public.dose_logs where id = 'e1000000-0000-8000-8000-00000000000e')]::text),
  array['20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002']::uuid[]::text,
  'the server names B, who planned the one and answered the other'
);

-- A answers it once more: the answer is A's now, the plan stays B's.
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select lives_ok(
  $$update public.dose_logs set status = 'taken' where id = 'e1000000-0000-8000-8000-00000000000e';
    update public.dose_plans set paused = true where id = 'a2000000-0000-7000-8000-00000000000a'$$,
  'the owner answers it again and pauses B''s plan'
);
select is(
  (select array[(select created_by from public.dose_plans where id = 'a2000000-0000-7000-8000-00000000000a'),
                (select answered_by from public.dose_logs where id = 'e1000000-0000-8000-8000-00000000000e')]::text),
  array['20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001']::uuid[]::text,
  'the last answerer is named, the planner kept'
);

-- A takes the answer back and undoes that; B, still holding it from before, writes it again.
update public.dose_logs set deleted_at = now() where id = 'e1000000-0000-8000-8000-00000000000e';
update public.dose_logs set deleted_at = null, tombstone_version = 1 where id = 'e1000000-0000-8000-8000-00000000000e';
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
set local role authenticated;
update public.dose_logs set status = 'missed', tombstone_version = 0 where id = 'e1000000-0000-8000-8000-00000000000e';
select is(
  (select status || ' ' || answered_by::text from public.dose_logs where id = 'e1000000-0000-8000-8000-00000000000e'),
  'taken 10000000-0000-4000-8000-000000000001',
  'a stale answer keeps the stored one, and its answerer'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
set local role authenticated;

-- What a plan and an answer may hold.
select is(
  pg_temp.exec_sqlstate($$insert into public.dose_plans (cabinet_id, id, product_id, amount_milli, times, weekdays, starts_on) values
    ('c0000000-0000-7000-8000-00000000000c', 'a3000000-0000-7000-8000-00000000000a', 'b1000000-0000-7000-8000-00000000000b', 1000, '["8:00"]', 127, '2026-10-19')$$),
  '23514',
  'a time not written HH:MM is refused'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.dose_plans (cabinet_id, id, product_id, amount_milli, times, weekdays, starts_on) values
    ('c0000000-0000-7000-8000-00000000000c', 'a3000000-0000-7000-8000-00000000000a', 'b1000000-0000-7000-8000-00000000000b', 1000,
     '["01:00","02:00","03:00","04:00","05:00","06:00","07:00","08:00","09:00"]', 127, '2026-10-19')$$),
  '23514',
  'so are nine times a day'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.dose_plans (cabinet_id, id, product_id, amount_milli, times, weekdays, starts_on) values
    ('c0000000-0000-7000-8000-00000000000c', 'a3000000-0000-7000-8000-00000000000a', 'b1000000-0000-7000-8000-00000000000b', 1000, '["08:00"]', 0, '2026-10-19')$$),
  '23514',
  'and a plan on no weekday'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.dose_plans (cabinet_id, id, product_id, amount_milli, times, weekdays, starts_on, ends_on) values
    ('c0000000-0000-7000-8000-00000000000c', 'a3000000-0000-7000-8000-00000000000a', 'b1000000-0000-7000-8000-00000000000b', 1000, '["08:00"]', 127, '2026-10-19', '2026-10-18')$$),
  '23514',
  'and one that ends before it starts'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.dose_plans (cabinet_id, id, product_id, amount_milli, times, weekdays, starts_on) values
    ('c0000000-0000-7000-8000-00000000000c', 'a3000000-0000-7000-8000-00000000000a', 'b1000000-0000-7000-8000-00000000000b', 0, '["08:00"]', 127, '2026-10-19')$$),
  '23514',
  'and a dose of nothing'
);
select is(
  pg_temp.exec_sqlstate($$update public.dose_logs set snoozed_until = now() where id = 'e1000000-0000-8000-8000-00000000000e'$$),
  '23514',
  'an answer is put off until a moment only when it was put off'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.dose_logs (cabinet_id, id, plan_id, due_on, due_time, status) values
    ('c0000000-0000-7000-8000-00000000000c', 'e3000000-0000-8000-8000-00000000000e', 'a1000000-0000-7000-8000-00000000000a', '2026-10-20', '24:00', 'taken')$$),
  '23514',
  'a dose is due at a time of day'
);

select * from finish();
rollback;
