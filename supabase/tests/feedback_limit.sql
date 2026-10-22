-- Feedback's send limit (migration 1): five an hour and twenty a day for an
-- account, ten a day between everyone signed out, and a ledger no client reads.
begin;

set local role postgres;
set local search_path = extensions, public, pg_catalog;

select extensions.plan(13);

-- SQLSTATE, not message text, under whichever role is active.
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

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'fiala-rls-a@example.invalid', '', now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'fiala-rls-b@example.invalid', '', now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now());

select ok(
  (select relrowsecurity from pg_class where oid = 'public.feedback_reports'::regclass),
  'feedback_reports has row-level security on'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select is(pg_temp.exec_sqlstate($$select * from public.feedback_reports$$), '42501', 'a signed-in request cannot read the ledger');
select is(pg_temp.exec_sqlstate($$delete from public.feedback_reports$$), '42501', 'or delete the rows counting against it');
select ok(
  (select bool_and(public.record_feedback_send()) from generate_series(1, 5)),
  'A may send five reports an hour'
);
select ok(not public.record_feedback_send(), 'but not a sixth');
select is(
  (select prosrc ~ 'pg_advisory_xact_lock' from pg_proc where oid = 'definers.record_feedback_send()'::regprocedure),
  true,
  'the limit serialises the calls of one account'
);

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
set local role authenticated;

select ok(public.record_feedback_send(), 'B''s limit is B''s own');

set local role postgres;
-- Past the hour but within the day: twenty is the ceiling.
update public.feedback_reports set created_at = now() - interval '2 hours' where user_id = '10000000-0000-4000-8000-000000000001';
insert into public.feedback_reports (user_id, created_at)
  select '10000000-0000-4000-8000-000000000001', now() - interval '3 hours' from generate_series(1, 15);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select ok(not public.record_feedback_send(), 'a day''s twenty holds after the hour has passed');

set local role postgres;
update public.feedback_reports set created_at = now() - interval '2 days' where user_id = '10000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select ok(public.record_feedback_send(), 'and a day later the account sends again');

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select ok(
  (select bool_and(public.record_signed_out_feedback_send()) from generate_series(1, 10)),
  'ten signed-out reports are taken'
);
select ok(not public.record_signed_out_feedback_send(), 'but not an eleventh');
select is(pg_temp.exec_sqlstate($$select public.record_feedback_send()$$), '42501', 'a signed-out request cannot use the account limit');

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select is(pg_temp.exec_sqlstate($$select public.record_signed_out_feedback_send()$$), '42501', 'nor a signed-in one the anonymous limit');

select * from extensions.finish();
rollback;
