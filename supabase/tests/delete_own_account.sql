-- An account deletes itself (migration 1): its own row in auth.users and no
-- other, and what it owns goes with it by cascade.
begin;

set local role postgres;
set local search_path = extensions, public, pg_catalog;

select extensions.plan(10);

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

insert into public.settings (user_id, id, key, value) values
  ('10000000-0000-4000-8000-000000000001', 'b4000000-0000-8000-8000-00000000000b', 'account_frozen', 'false'),
  ('20000000-0000-4000-8000-000000000002', 'b5000000-0000-8000-8000-00000000000b', 'account_frozen', 'false');
insert into public.packages (cabinet_id, id, product_id, unit) values
  ('10000000-0000-4000-8000-000000000001', 'c1000000-0000-7000-8000-00000000000c', 'c2000000-0000-7000-8000-00000000000c', 'tablet'),
  ('20000000-0000-4000-8000-000000000002', 'c1000000-0000-7000-8000-00000000000c', 'c2000000-0000-7000-8000-00000000000c', 'tablet');

set local role anon;
select is(pg_temp.exec_sqlstate($$select public.delete_own_account()$$), '42501', 'a signed-out request cannot ask for it');
select is(
  pg_temp.exec_sqlstate($$select definers.delete_own_account()$$), '42501',
  'nor reach the definer behind it'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select lives_ok($$select public.delete_own_account()$$, 'A deletes its account');

set local role postgres;
select is((select count(*) from auth.users where id = '10000000-0000-4000-8000-000000000001'), 0::bigint, 'A is gone');
select is((select count(*) from auth.users where id = '20000000-0000-4000-8000-000000000002'), 1::bigint, 'B is not');
select is((select count(*) from public.settings where user_id = '10000000-0000-4000-8000-000000000001'), 0::bigint, 'A''s settings went with it');
select is((select count(*) from public.settings where user_id = '20000000-0000-4000-8000-000000000002'), 1::bigint, 'and B''s did not');
select is((select count(*) from public.packages where cabinet_id = '10000000-0000-4000-8000-000000000001'), 0::bigint, 'A''s cabinet went with it');
select is((select count(*) from public.packages where cabinet_id = '20000000-0000-4000-8000-000000000002'), 1::bigint, 'and B''s, holding a box of the same id, did not');
select is(
  (select count(*) from pg_proc where oid = 'public.delete_own_account()'::regprocedure and not prosecdef),
  1::bigint,
  'the function a client calls runs as the caller'
);

select * from extensions.finish();
rollback;
