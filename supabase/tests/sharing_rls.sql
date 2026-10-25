-- What membership lets each person do in a shared cabinet (migration 4),
-- asserted as Gital's sharing is. Members are fixtures here, made as
-- postgres, since only the server makes one; the invitation that will is F2.2.
begin;

set local role postgres;
set local search_path = extensions, public, pg_catalog;

select extensions.plan(61);

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
  ('c0000000-0000-7000-8000-00000000000c', 'a1000000-0000-7000-8000-00000000000a', 'Parol'),
  -- What A keeps private (F2.5) is in A's own cabinet.
  ('10000000-0000-4000-8000-000000000001', 'a9000000-0000-7000-8000-00000000000a', 'Özel');
-- The household's photo (migration 9), placed by its owner.
update public.cabinets set photo_id = 'e0000000-0000-7000-8000-00000000000e' where id = 'c0000000-0000-7000-8000-00000000000c';
insert into storage.objects (bucket_id, name, owner_id) values
  ('photos', 'e0000000-0000-7000-8000-00000000000e/full.jpg', '10000000-0000-4000-8000-000000000001');

-- A deletion undone by another member keeps the photo A sent (migration 20):
-- the tombstone keeps its id, so the undo names nothing new.
insert into public.products (cabinet_id, id, name, photo_id) values
  ('c0000000-0000-7000-8000-00000000000c', 'a2000000-0000-7000-8000-00000000000a', 'Majezik', 'e1000000-0000-7000-8000-00000000000e');
insert into storage.objects (bucket_id, name, owner_id) values
  ('photos', 'e1000000-0000-7000-8000-00000000000e/full.jpg', '10000000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
set local role authenticated;
update public.products set deleted_at = now() where id = 'a2000000-0000-7000-8000-00000000000a';
update public.products set deleted_at = null, name = 'Majezik', photo_id = 'e1000000-0000-7000-8000-00000000000e', tombstone_version = 1
  where id = 'a2000000-0000-7000-8000-00000000000a';
set local role postgres;
select is(
  (select name || ' ' || photo_id from public.products where id = 'a2000000-0000-7000-8000-00000000000a'),
  'Majezik e1000000-0000-7000-8000-00000000000e',
  'an editor''s undo of a deletion keeps the photo the owner sent'
);
-- Gone again, so the counts below are the household's own.
delete from public.products where id = 'a2000000-0000-7000-8000-00000000000a';
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where name = 'e1000000-0000-7000-8000-00000000000e/full.jpg';
select set_config('storage.allow_delete_query', 'false', true);

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
-- As PostgREST pushes it: an upsert that returns the row it wrote.
select lives_ok(
  $$insert into public.cabinets (id, owner_id, name) values
    ('d0000000-0000-7000-8000-00000000000d', '40000000-0000-4000-8000-000000000004', 'Ev')
    on conflict (id) do update set name = excluded.name returning id$$,
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

select is((select count(*) from public.products), 1::bigint, 'an editor reads the cabinet, and nothing its owner keeps private');
select is(
  pg_temp.exec_sqlstate($$insert into public.products (cabinet_id, id, name) values
    ('10000000-0000-4000-8000-000000000001', 'a8000000-0000-7000-8000-00000000000a', 'X')$$),
  '42501',
  'nor writes there'
);
select is((select count(*) from public.cabinet_members), 3::bigint, 'and who is in it');
select is((select count(*) from public.cabinets), 2::bigint, 'and holds it beside their own');
select is((select count(*) from storage.objects where bucket_id = 'photos'), 1::bigint, 'and sees its photo');
select is(
  pg_temp.exec_sqlstate($$insert into storage.objects (bucket_id, name, owner_id) values
    ('photos', 'e0000000-0000-7000-8000-00000000000e/thumb.jpg', '20000000-0000-4000-8000-000000000002')$$),
  '42501',
  'but places none at its id: the photo is the owner''s, as the name is'
);
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

-- A deleted household (migration 18): its rows leave every read and refuse
-- every write, while its own row and its members still tell each device of
-- the delete and of the undo.
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
set local role authenticated;
update public.cabinets set deleted_at = now() where id = 'c0000000-0000-7000-8000-00000000000c';
create temp table before_undo as select tombstone_version as generation from public.cabinets where id = 'c0000000-0000-7000-8000-00000000000c';
select is((select count(*) from public.products where cabinet_id = 'c0000000-0000-7000-8000-00000000000c'), 0::bigint, 'a deleted household''s rows are hidden from its owner');
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
select is((select count(*) from public.products where cabinet_id = 'c0000000-0000-7000-8000-00000000000c'), 0::bigint, 'and from its members');
select is((select count(*) from public.packages where cabinet_id = 'c0000000-0000-7000-8000-00000000000c'), 0::bigint, 'every table of it');
select isnt((select deleted_at from public.cabinets where id = 'c0000000-0000-7000-8000-00000000000c'), null, 'but its row says it was deleted');
select is((select count(*) from public.cabinet_members where cabinet_id = 'c0000000-0000-7000-8000-00000000000c'), 3::bigint, 'and its members are still known');
select is(
  pg_temp.exec_sqlstate($$insert into public.products (cabinet_id, id, name) values ('c0000000-0000-7000-8000-00000000000c', 'a7000000-0000-7000-8000-00000000000a', 'Yeni')$$),
  '42501',
  'nothing is added to it'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.products (cabinet_id, id, name) values ('c0000000-0000-7000-8000-00000000000c', 'a1000000-0000-7000-8000-00000000000a', 'Değişti')
    on conflict (cabinet_id, id) do update set name = excluded.name returning id$$),
  '42501',
  'nor changed in it, as a push upserts'
);
select is(private.in_cabinet('c0000000-0000-7000-8000-00000000000c'), true, 'its members are still in it');
select is(private.can_read_cabinet('c0000000-0000-7000-8000-00000000000c'), false, 'but read none of it');
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
update public.cabinets set deleted_at = null where id = 'c0000000-0000-7000-8000-00000000000c';
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
select is((select count(*) from public.products where cabinet_id = 'c0000000-0000-7000-8000-00000000000c'), 1::bigint, 'the undo brings its rows back');
set local role postgres;
select is(
  (select tombstone_version from public.cabinets where id = 'c0000000-0000-7000-8000-00000000000c'),
  (select generation from before_undo),
  'under the delete''s generation, which keys the device''s fetch of it whole'
);

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
set local role postgres;
update storage.objects set created_at = now() - interval '31 days' where bucket_id = 'photos';
set local role authenticated;
select is((select count(*) from public.unnamed_photos()), 0::bigint, 'and the photo it names is never swept as unnamed');

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

-- Realtime (migration 10, Gital's): each change in a household is told on its
-- private channel, which only its members hear and where nobody speaks.
set local role postgres;
select ok(
  (select count(*) > 0 from realtime.messages
    where topic = 'cabinet:c0000000-0000-7000-8000-00000000000c' and event = 'moved' and private and extension = 'broadcast' and payload ? 'by'),
  'a change in a household is told on its private channel, with who made it'
);
select is(
  (select count(*) from realtime.messages where topic = 'cabinet:40000000-0000-4000-8000-000000000004'),
  0::bigint,
  'a personal cabinet''s on none'
);
select set_config('realtime.topic', 'cabinet:c0000000-0000-7000-8000-00000000000c', true);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
set local role authenticated;
select ok((select count(*) > 0 from realtime.messages), 'its members hear it');
select is(
  pg_temp.exec_sqlstate($$insert into realtime.messages (topic, extension, event, payload, private) values ('cabinet:c0000000-0000-7000-8000-00000000000c', 'broadcast', 'moved', '{}', true)$$),
  '42501',
  'but only the server says it moved'
);
select set_config('realtime.topic', 'cabinet:not-a-cabinet', true);
select is((select count(*) from realtime.messages), 0::bigint, 'a topic that names no cabinet is nobody''s');
select set_config('realtime.topic', 'cabinet:c0000000-0000-7000-8000-00000000000c', true);
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
select is((select count(*) from realtime.messages), 0::bigint, 'someone no longer in it hears nothing');

-- The one removed is told on their own channel, which only they hear.
set local role postgres;
select ok(
  (select count(*) > 0 from realtime.messages
    where topic = 'user:20000000-0000-4000-8000-000000000002' and event = 'moved' and private and payload ->> 'cabinet' = 'c0000000-0000-7000-8000-00000000000c'),
  'someone removed from a household is told on their own channel'
);
select set_config('realtime.topic', 'user:20000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select ok((select count(*) > 0 from realtime.messages), 'and hears it');
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select is((select count(*) from realtime.messages), 0::bigint, 'nobody else does');
select set_config('realtime.topic', '', true);

-- And a push of many rows is told once.
set local role postgres;
create temp table heard_before as select count(*) as n from realtime.messages where topic = 'cabinet:c0000000-0000-7000-8000-00000000000c';
insert into public.products (cabinet_id, id, name)
select 'c0000000-0000-7000-8000-00000000000c', gen_random_uuid(), 'bulk ' || n from generate_series(1, 3) n;
select is(
  (select count(*) from realtime.messages where topic = 'cabinet:c0000000-0000-7000-8000-00000000000c') - (select n from heard_before),
  1::bigint,
  'three rows in one push are one nudge'
);

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
