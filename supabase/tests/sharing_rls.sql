-- What membership lets each person do in a shared cabinet (migration 4),
-- asserted as Gital's sharing is. Members are fixtures here, made as
-- postgres, since only the server makes one; the invitation that will is F2.2.
begin;

set local role postgres;
set local search_path = extensions, public, pg_catalog;

select extensions.plan(35);

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

-- A owns the shared cabinet, B edits it, C views it, D is outside it.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       'fiala-share-' || u.n || '@example.invalid', '', now(),
       '{"provider":"email","providers":["email"]}', '{}', now(), now()
  from (values ('a', '10000000-0000-4000-8000-000000000001'::uuid),
               ('b', '20000000-0000-4000-8000-000000000002'::uuid),
               ('c', '30000000-0000-4000-8000-000000000003'::uuid),
               ('d', '40000000-0000-4000-8000-000000000004'::uuid)) as u (n, id);

select is(
  (select count(*) from public.cabinets
    where id = owner_id and owner_id in ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002',
                                         '30000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000004')),
  4::bigint,
  'every new account gets its personal cabinet, under its own id'
);
select is(
  (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'cabinets' and grantee in ('anon', 'authenticated')),
  'INSERT,SELECT,UPDATE',
  'a signed-in request reads and writes cabinets, never deletes one; anon holds nothing'
);
select is(
  (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'cabinet_members' and grantee in ('anon', 'authenticated')),
  'INSERT,SELECT,UPDATE',
  'members are read and updated, through an upsert''s insert'
);

insert into public.cabinets (id, owner_id) values ('c0000000-0000-7000-8000-00000000000c', '10000000-0000-4000-8000-000000000001');
insert into public.cabinet_members (cabinet_id, user_id, role, name) values
  ('c0000000-0000-7000-8000-00000000000c', '10000000-0000-4000-8000-000000000001', 'owner', 'Ömer'),
  ('c0000000-0000-7000-8000-00000000000c', '20000000-0000-4000-8000-000000000002', 'editor', 'Eda'),
  ('c0000000-0000-7000-8000-00000000000c', '30000000-0000-4000-8000-000000000003', 'viewer', 'Can');
insert into public.products (cabinet_id, id, name) values
  ('c0000000-0000-7000-8000-00000000000c', 'a1000000-0000-7000-8000-00000000000a', 'Parol');

-- D, outside.
select set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000004', true);
set local role authenticated;

select is((select count(*) from public.products), 0::bigint, 'D reads nothing in a cabinet it is not in');
select is((select count(*) from public.cabinet_members), 0::bigint, 'nor who is in it');
select is((select count(*) from public.cabinets), 1::bigint, 'and sees only its own cabinet');
select is(
  pg_temp.exec_sqlstate($$insert into public.cabinets (id, owner_id) values
    ('20000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000004')$$),
  '42501',
  'no device makes a cabinet under an account''s id, which would take that person''s own'
);
select lives_ok(
  $$insert into public.cabinets (id, owner_id, name) values
    ('d0000000-0000-7000-8000-00000000000d', '40000000-0000-4000-8000-000000000004', 'Ev')$$,
  'a device makes a household''s cabinet'
);
update public.cabinets set name = 'Yazlık', owner_id = '20000000-0000-4000-8000-000000000002'
 where id = 'd0000000-0000-7000-8000-00000000000d';
select is(
  (select name || ':' || owner_id from public.cabinets where id = 'd0000000-0000-7000-8000-00000000000d'),
  'Yazlık:40000000-0000-4000-8000-000000000004',
  'its owner renames it, and gives it to nobody'
);
update public.cabinets set deleted_at = now() where id = '40000000-0000-4000-8000-000000000004';
select is(
  (select deleted_at from public.cabinets where id = '40000000-0000-4000-8000-000000000004'),
  null,
  'the personal cabinet is not deleted while its account lives'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.products (cabinet_id, id, name) values
    ('c0000000-0000-7000-8000-00000000000c', 'a2000000-0000-7000-8000-00000000000a', 'X')$$),
  '42501',
  'nor writes into it'
);

-- B, an editor.
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
set local role authenticated;

select is((select count(*) from public.products), 1::bigint, 'an editor reads the cabinet');
select is((select count(*) from public.cabinet_members), 3::bigint, 'and who is in it');
select is((select count(*) from public.cabinets), 2::bigint, 'and holds it beside their own');
update public.cabinets set name = 'X', deleted_at = now() where id = 'c0000000-0000-7000-8000-00000000000c';
select is(
  (select name || ':' || (deleted_at is null) from public.cabinets where id = 'c0000000-0000-7000-8000-00000000000c'),
  ':true',
  'but neither renames nor deletes it'
);
select lives_ok(
  $$insert into public.packages (cabinet_id, id, product_id, unit) values
    ('c0000000-0000-7000-8000-00000000000c', 'a3000000-0000-7000-8000-00000000000a', 'a1000000-0000-7000-8000-00000000000a', 'tablet')$$,
  'an editor adds a box'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.cabinet_members (cabinet_id, user_id, role) values
    ('c0000000-0000-7000-8000-00000000000c', '40000000-0000-4000-8000-000000000004', 'editor')$$),
  '42501',
  'a member writes nobody new into the cabinet'
);
update public.cabinet_members set role = 'owner', cabinet_id = '20000000-0000-4000-8000-000000000002', seen_at = now()
 where user_id = '20000000-0000-4000-8000-000000000002';
select is(
  (select role || ':' || cabinet_id from public.cabinet_members where user_id = '20000000-0000-4000-8000-000000000002'),
  'editor:c0000000-0000-7000-8000-00000000000c',
  'nor makes themselves its owner, or moves their row to another cabinet'
);
select isnt(
  (select seen_at from public.cabinet_members where user_id = '20000000-0000-4000-8000-000000000002'),
  null,
  'though they keep when they last looked'
);
select lives_ok(
  $$insert into public.cabinet_members (id, cabinet_id, user_id, role, name)
    select id, cabinet_id, user_id, role, 'Eda Y.' from public.cabinet_members where user_id = '20000000-0000-4000-8000-000000000002'
    on conflict (id) do update set name = excluded.name$$,
  'a device pushes its own member row as PostgREST does, an upsert'
);
select is(
  (select name from public.cabinet_members where user_id = '20000000-0000-4000-8000-000000000002'),
  'Eda Y.',
  'and its name is changed'
);
update public.cabinet_members set name = 'X', role = 'viewer', deleted_at = now()
 where user_id = '10000000-0000-4000-8000-000000000001';
select is(
  (select role || ':' || name || ':' || (deleted_at is null) from public.cabinet_members where user_id = '10000000-0000-4000-8000-000000000001'),
  'owner:Ömer:true',
  'nor touch the owner''s row'
);

-- C, a viewer.
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000003', true);
set local role authenticated;

select is((select count(*) from public.packages), 1::bigint, 'a viewer reads the cabinet');
select is(
  pg_temp.exec_sqlstate($$insert into public.packages (cabinet_id, id, product_id, unit) values
    ('c0000000-0000-7000-8000-00000000000c', 'a4000000-0000-7000-8000-00000000000a', 'a1000000-0000-7000-8000-00000000000a', 'tablet')$$),
  '42501',
  'but adds nothing'
);
update public.products set note = 'X' where id = 'a1000000-0000-7000-8000-00000000000a';
set local role postgres;
select is((select note from public.products where id = 'a1000000-0000-7000-8000-00000000000a'), null, 'and changes nothing');

-- A, the owner.
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
set local role authenticated;

update public.cabinet_members set role = 'editor' where user_id = '30000000-0000-4000-8000-000000000003';
select is(
  (select role from public.cabinet_members where user_id = '30000000-0000-4000-8000-000000000003'),
  'editor',
  'the owner changes a role'
);
update public.cabinet_members set deleted_at = now() where user_id = '10000000-0000-4000-8000-000000000001';
select is(
  (select deleted_at from public.cabinet_members where user_id = '10000000-0000-4000-8000-000000000001'),
  null,
  'but does not leave their own cabinet'
);
update public.cabinet_members set deleted_at = now() where user_id = '20000000-0000-4000-8000-000000000002';
select lives_ok(
  $$update public.cabinets set name = 'Ev' where id = 'c0000000-0000-7000-8000-00000000000c'$$,
  'the owner names the household'
);

-- B, removed.
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
set local role authenticated;

select is((select count(*) from public.packages), 0::bigint, 'a removed member reads nothing more');
select isnt(
  (select deleted_at from public.cabinet_members where user_id = '20000000-0000-4000-8000-000000000002'),
  null,
  'but sees their own removal, so the device can let the cabinet go'
);
update public.cabinet_members set deleted_at = null where user_id = '20000000-0000-4000-8000-000000000002';
select is((select count(*) from public.packages), 0::bigint, 'and cannot undo it');

-- C leaves.
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000003', true);
set local role authenticated;

update public.cabinet_members set deleted_at = now() where user_id = '30000000-0000-4000-8000-000000000003';
select is((select count(*) from public.products), 0::bigint, 'a member who leaves reads the cabinet no more');

-- Deleting an account.
set local role postgres;
delete from auth.users where id = '30000000-0000-4000-8000-000000000003';
select is(
  (select count(*) from public.cabinet_members where cabinet_id = 'c0000000-0000-7000-8000-00000000000c'),
  2::bigint,
  'a member''s account deletion takes only their membership'
);
delete from auth.users where id = '10000000-0000-4000-8000-000000000001';
select is(
  (select count(*) from public.packages where cabinet_id = 'c0000000-0000-7000-8000-00000000000c'),
  0::bigint,
  'the owner''s takes the cabinet they made and what is in it'
);
select is(
  (select count(*) from public.cabinets where owner_id = '20000000-0000-4000-8000-000000000002'),
  1::bigint,
  'and leaves everyone else''s'
);

select * from extensions.finish();
rollback;
