-- What settings, the one table the shell syncs, lets one account do to
-- another's rows, asserted (migration 1). Helix's harness: fixtures as
-- postgres, every assertion as the role a request would carry, and a rollback
-- at the end. A feature's table adds its own refusals here.
begin;

set local role postgres;
set local search_path = extensions, public, pg_catalog;

select extensions.plan(19);

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

-- The shape: three policies, all for signed-in requests, no delete.
select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'settings' and roles = array['authenticated']::name[]),
  3::bigint,
  'settings has select, insert and update policies for authenticated'
);
select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'settings'
      and (grantee = 'anon' or (grantee = 'authenticated' and privilege_type not in ('SELECT','INSERT','UPDATE')))),
  0::bigint,
  'anon holds nothing, and a signed-in request cannot delete'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.settings'::regclass),
  'settings has row-level security on'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select lives_ok(
  $$insert into public.settings (user_id, id, key, value, updated_at) values
    ('10000000-0000-4000-8000-000000000001', 'b4000000-0000-8000-8000-00000000000b', 'account_frozen', 'true', '2000-01-01')$$,
  'A freezes its account'
);
select ok(
  (select updated_at > now() - interval '1 minute' from public.settings where id = 'b4000000-0000-8000-8000-00000000000b'),
  'updated_at is the server''s clock, not the device''s'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.settings (user_id, id, key, value) values
    ('20000000-0000-4000-8000-000000000002', 'b1000000-0000-8000-8000-00000000000b', 'account_frozen', 'true')$$),
  '42501',
  'A cannot write a setting into B''s name'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.settings (user_id, id, key, value) values
    ('10000000-0000-4000-8000-000000000001', 'b2000000-0000-8000-8000-00000000000b', '', 'x')$$),
  '23514',
  'a setting needs a key'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.settings (user_id, id, key, value) values
    ('10000000-0000-4000-8000-000000000001', 'b3000000-0000-8000-8000-00000000000b', 'big', repeat('x', 10001))$$),
  '23514',
  'and a value the device cannot hold is refused, which would stop every pull'
);
select is(
  pg_temp.exec_sqlstate($$delete from public.settings where id = 'b4000000-0000-8000-8000-00000000000b'$$),
  '42501',
  'a delete is refused: deletes are tombstones'
);

-- Delete generations (Helix's migration 12).
update public.settings set deleted_at = now() where id = 'b4000000-0000-8000-8000-00000000000b';
select is(
  (select tombstone_version from public.settings where id = 'b4000000-0000-8000-8000-00000000000b'),
  1::bigint,
  'a delete moves the generation on by one'
);
update public.settings set deleted_at = null, value = 'false', tombstone_version = 0 where id = 'b4000000-0000-8000-8000-00000000000b';
select ok(
  (select deleted_at is not null and value = 'true' from public.settings where id = 'b4000000-0000-8000-8000-00000000000b'),
  'a device that never saw the delete cannot undo it'
);
select is(
  pg_temp.exec_sqlstate($$update public.settings set tombstone_version = 7 where id = 'b4000000-0000-8000-8000-00000000000b'$$),
  '23514',
  'a generation from nowhere is refused'
);
update public.settings set deleted_at = null, tombstone_version = 1 where id = 'b4000000-0000-8000-8000-00000000000b';
select ok(
  (select deleted_at is null and tombstone_version = 1 from public.settings where id = 'b4000000-0000-8000-8000-00000000000b'),
  'an undo at the generation it saw brings the row back'
);
select is(
  (select max_id from public.sync_cursors() where table_name = 'settings'),
  'b4000000-0000-8000-8000-00000000000b'::uuid,
  'the change probe names A''s newest setting'
);

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
set local role authenticated;

select is((select count(*) from public.settings), 0::bigint, 'B reads none of A''s settings');
select is(
  (select max_id from public.sync_cursors() where table_name = 'settings'),
  null::uuid,
  'and the change probe shows B nothing of A''s'
);
update public.settings set value = 'false' where id = 'b4000000-0000-8000-8000-00000000000b';
set local role postgres;
select is(
  (select value from public.settings where id = 'b4000000-0000-8000-8000-00000000000b'),
  'true',
  'B''s update of A''s setting touches nothing'
);
set local role anon;
select is(pg_temp.exec_sqlstate($$select count(*) from public.settings$$), '42501', 'a signed-out request is refused outright');
select is(pg_temp.exec_sqlstate($$select count(*) from public.sync_cursors()$$), '42501', 'and so is its change probe');

select * from extensions.finish();
rollback;
