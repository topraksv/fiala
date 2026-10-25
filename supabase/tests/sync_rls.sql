-- What the synced tables let one account do to another's rows, asserted:
-- settings (migration 1), scoped by person, and the cabinet's (migration 2),
-- scoped by cabinet. Helix's harness: fixtures as postgres, every assertion
-- as the role a request would carry, and a rollback at the end. A feature's
-- table adds its own refusals here.
begin;

set local role postgres;
set local search_path = extensions, public, pg_catalog;

select extensions.plan(63);

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

-- The cabinet's tables (migration 2): until sharing, a cabinet is its
-- account's, and its rows are no one else's.
set local role postgres;
select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('people', 'locations', 'products', 'packages', 'package_moves', 'package_changes', 'tags', 'product_tags')
      and roles = array['authenticated']::name[] and cmd in ('SELECT', 'INSERT', 'UPDATE')),
  24::bigint,
  'each cabinet table has select, insert and update policies for authenticated'
);
select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('people', 'locations', 'products', 'packages', 'package_moves', 'package_changes', 'tags', 'product_tags')
      and (grantee = 'anon' or (grantee = 'authenticated' and privilege_type not in ('SELECT','INSERT','UPDATE')))),
  0::bigint,
  'anon holds nothing on them, and a signed-in request cannot delete'
);
select is(
  (select count(*) from pg_class
    where oid in ('public.people'::regclass, 'public.locations'::regclass, 'public.products'::regclass, 'public.packages'::regclass, 'public.package_moves'::regclass, 'public.package_changes'::regclass, 'public.tags'::regclass, 'public.product_tags'::regclass)
      and relrowsecurity),
  8::bigint,
  'all eight have row-level security on'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select lives_ok(
  $$insert into public.products (cabinet_id, id, name, gtin) values
      ('10000000-0000-4000-8000-000000000001', 'c2000000-0000-8000-8000-00000000000c', 'Parol', '8699546090112');
    insert into public.packages (cabinet_id, id, product_id, unit, expires_on) values
      ('10000000-0000-4000-8000-000000000001', 'c1000000-0000-7000-8000-00000000000c', 'c2000000-0000-8000-8000-00000000000c', 'tablet', '2027-03-31');
    insert into public.package_moves (cabinet_id, id, package_id, quantity_milli, reason) values
      ('10000000-0000-4000-8000-000000000001', 'c3000000-0000-7000-8000-00000000000c', 'c1000000-0000-7000-8000-00000000000c', 20000, 'initial')$$,
  'A adds a box of Parol to its cabinet'
);
select lives_ok(
  $$update public.products set note = 'Tok karnına', starred = true, wanted = true
     where id = 'c2000000-0000-8000-8000-00000000000c'$$,
  'A notes, stars and wants Parol'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.package_changes (cabinet_id, id, package_id, changes, created_by) values
    ('10000000-0000-4000-8000-000000000001', 'ce000000-0000-7000-8000-00000000000c', 'c1000000-0000-7000-8000-00000000000c', '{"note":[null,"x"]}', '20000000-0000-4000-8000-000000000002');
    insert into public.package_moves (cabinet_id, id, package_id, quantity_milli, reason, created_by) values
    ('10000000-0000-4000-8000-000000000001', 'c3000000-0000-7000-8000-00000000000c', 'c1000000-0000-7000-8000-00000000000c', 20000, 'initial', '20000000-0000-4000-8000-000000000002')
    on conflict (cabinet_id, id) do update set created_by = excluded.created_by$$),
  null,
  'A writes an edit and pushes its move again, each naming B as its writer'
);
select is(
  (select array[(select created_by from public.package_changes where id = 'ce000000-0000-7000-8000-00000000000c'),
                (select created_by from public.package_moves where id = 'c3000000-0000-7000-8000-00000000000c')]::text),
  array['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001']::uuid[]::text,
  'the server names A, who wrote both, and keeps it'
);
-- A second phone that never pulled Parol scans the same box: its own row under the same id, as an upsert sends it.
select lives_ok(
  $$insert into public.products (cabinet_id, id, name, gtin, strength, note, starred, wanted, photo_id, created_at) values
      ('10000000-0000-4000-8000-000000000001', 'c2000000-0000-8000-8000-00000000000c', 'Parol', '8699546090112', '500 mg', null, false, false, null, now() + interval '1 second')
    on conflict (cabinet_id, id) do update set
      name = excluded.name, strength = excluded.strength, note = excluded.note, starred = excluded.starred,
      wanted = excluded.wanted, photo_id = excluded.photo_id, created_at = excluded.created_at$$,
  'a phone that never pulled Parol pushes its own row over it'
);
select is(
  (select (note, starred, wanted, strength) from public.products where id = 'c2000000-0000-8000-8000-00000000000c')::text,
  ('Tok karnına', true, true, '500 mg')::text,
  'its nulls and falses blank nothing it never saw, and what it says still wins'
);
select is(
  (select created_at <= now() from public.products where id = 'c2000000-0000-8000-8000-00000000000c'),
  true,
  'the product keeps the day it was first made'
);
select is(
  pg_temp.exec_sqlstate($$update public.products set tombstone_version = 9007199254740992 where id = 'c2000000-0000-8000-8000-00000000000c'$$),
  '23514',
  'a number past what a device holds is refused, so no pull stops on it'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.packages (cabinet_id, id, product_id, unit) values
    ('20000000-0000-4000-8000-000000000002', 'c4000000-0000-7000-8000-00000000000c', 'c2000000-0000-8000-8000-00000000000c', 'tablet')$$),
  '42501',
  'A cannot put a box into B''s cabinet'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.product_tags (cabinet_id, id, product_id, tag_id) values
    ('20000000-0000-4000-8000-000000000002', 'ca000000-0000-8000-8000-00000000000c', 'c2000000-0000-8000-8000-00000000000c', 'cb000000-0000-7000-8000-00000000000c')$$),
  '42501',
  'nor tag a product there'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.package_changes (cabinet_id, id, package_id, changes) values
    ('20000000-0000-4000-8000-000000000002', 'cc000000-0000-7000-8000-00000000000c', 'c1000000-0000-7000-8000-00000000000c', '{"note":[null,"x"]}')$$),
  '42501',
  'nor write a box''s history there'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.packages (cabinet_id, id, product_id, unit, warn_days) values
    ('10000000-0000-4000-8000-000000000001', 'cd000000-0000-7000-8000-00000000000c', 'c2000000-0000-8000-8000-00000000000c', 'tablet', 0)$$),
  '23514',
  'a warning no days ahead is refused'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.people (cabinet_id, id, name, allergies) values
    ('10000000-0000-4000-8000-000000000001', 'd5000000-0000-7000-8000-00000000000c', 'Ali', repeat('x', 501))$$),
  '23514',
  'an allergy past 500 characters is refused'
);
insert into public.people (cabinet_id, id, name, allergies) values
  ('10000000-0000-4000-8000-000000000001', 'd6000000-0000-7000-8000-00000000000c', 'Ayşe', 'penisilin'),
  ('10000000-0000-4000-8000-000000000001', 'd7000000-0000-7000-8000-00000000000c', 'Veli', 'polen');
update public.people set deleted_at = now() where id = 'd6000000-0000-7000-8000-00000000000c';
select is(
  (select name || coalesce(allergies, '-') from public.people where id = 'd6000000-0000-7000-8000-00000000000c'),
  '-',
  'a deleted person keeps neither name nor allergy on the server'
);
select is(
  (select name || allergies from public.people where id = 'd7000000-0000-7000-8000-00000000000c'),
  'Velipolen',
  'a living person keeps both'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.packages (cabinet_id, id, product_id, unit, check_of) values
    ('10000000-0000-4000-8000-000000000001', 'cf000000-0000-7000-8000-00000000000c', 'c2000000-0000-8000-8000-00000000000c', 'tablet', '20000000-0000-4000-8000-000000000002')$$),
  '23514',
  'an ask to check a box names both whom and since when'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.products (cabinet_id, id, name, gtin) values
    ('10000000-0000-4000-8000-000000000001', 'c5000000-0000-7000-8000-00000000000c', 'Parol', '869954609011X')$$),
  '23514',
  'a GTIN that is not 8 to 14 digits is refused'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.package_moves (cabinet_id, id, package_id, quantity_milli, reason) values
    ('10000000-0000-4000-8000-000000000001', 'c6000000-0000-7000-8000-00000000000c', 'c1000000-0000-7000-8000-00000000000c', 0, 'use')$$),
  '23514',
  'a move of nothing is refused'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.packages (cabinet_id, id, product_id, unit) values
    ('10000000-0000-4000-8000-000000000001', 'c7000000-0000-7000-8000-00000000000c', 'c2000000-0000-8000-8000-00000000000c', 'kutu')$$),
  '23514',
  'and a unit the device does not know'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.packages (cabinet_id, id, product_id, unit, disposition) values
    ('10000000-0000-4000-8000-000000000001', 'c9000000-0000-7000-8000-00000000000c', 'c2000000-0000-8000-8000-00000000000c', 'tablet', 'sold')$$),
  '23514',
  'or a way out of the cabinet it does not know'
);
select is(
  pg_temp.exec_sqlstate($$insert into public.packages (cabinet_id, id, product_id, unit, expires_on) values
    ('10000000-0000-4000-8000-000000000001', 'c8000000-0000-7000-8000-00000000000c', 'c2000000-0000-8000-8000-00000000000c', 'tablet', '2027-02-30')$$),
  '22008',
  'and a day that is not on the calendar'
);
select is(
  pg_temp.exec_sqlstate($$delete from public.packages where id = 'c1000000-0000-7000-8000-00000000000c'$$),
  '42501',
  'a box is never deleted, only tombstoned'
);
select is(
  (select max_id from public.sync_cursors() where table_name = 'packages'),
  'c1000000-0000-7000-8000-00000000000c'::uuid,
  'the change probe names A''s newest box'
);

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
set local role authenticated;

select is(
  (select (select count(*) from public.products) + (select count(*) from public.packages) + (select count(*) from public.package_moves)),
  0::bigint,
  'B reads nothing of A''s cabinet'
);
select is(
  (select count(max_id) from public.sync_cursors() where table_name not in ('settings', 'cabinets') or (table_name = 'cabinets' and max_id <> '20000000-0000-4000-8000-000000000002')),
  0::bigint,
  'and its change probe shows B none of it'
);
update public.packages set expires_on = '2020-01-01' where id = 'c1000000-0000-7000-8000-00000000000c';
select lives_ok(
  $$insert into public.packages (cabinet_id, id, product_id, unit) values
    ('20000000-0000-4000-8000-000000000002', 'c1000000-0000-7000-8000-00000000000c', 'c2000000-0000-8000-8000-00000000000c', 'ml')$$,
  'B keeps a box of the same id in its own cabinet: the key is the cabinet''s and the id'
);
set local role postgres;
select is(
  (select expires_on from public.packages where cabinet_id = '10000000-0000-4000-8000-000000000001' and id = 'c1000000-0000-7000-8000-00000000000c'),
  '2027-03-31'::date,
  'B''s update of A''s box touched nothing'
);
select is(
  (select count(*) from public.packages where id = 'c1000000-0000-7000-8000-00000000000c'),
  2::bigint,
  'and each cabinet holds its own box'
);
set local role anon;
select is(pg_temp.exec_sqlstate($$select count(*) from public.packages$$), '42501', 'a signed-out request reads no cabinet');

-- Photos (migration 2, Gital's): read by whoever can read a row naming them,
-- and by the uploader. A's box names f0 and f2; A uploaded f0 and f1.
set local role postgres;
insert into storage.objects (bucket_id, name, owner_id) values
  ('photos', 'f0000000-0000-7000-8000-00000000000f/full.jpg', '10000000-0000-4000-8000-000000000001'),
  ('photos', 'f1000000-0000-7000-8000-00000000000f/full.jpg', '10000000-0000-4000-8000-000000000001');
insert into public.packages (cabinet_id, id, product_id, unit, photo_id) values
  ('10000000-0000-4000-8000-000000000001', 'd1000000-0000-7000-8000-00000000000d', 'c2000000-0000-8000-8000-00000000000c', 'tablet', 'f0000000-0000-7000-8000-00000000000f'),
  ('10000000-0000-4000-8000-000000000001', 'd2000000-0000-7000-8000-00000000000d', 'c2000000-0000-8000-8000-00000000000c', 'tablet', 'f2000000-0000-7000-8000-00000000000f');
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
set local role authenticated;

select is(
  (select count(*) from storage.objects where bucket_id = 'photos'),
  0::bigint,
  'B reads no photo of A''s'
);
select is(
  pg_temp.exec_sqlstate($$insert into storage.objects (bucket_id, name, owner_id) values
    ('photos', 'not-a-photo.png', '20000000-0000-4000-8000-000000000002')$$),
  '42501',
  'a name the app never makes is refused'
);
select is(
  pg_temp.exec_sqlstate($$insert into storage.objects (bucket_id, name, owner_id) values
    ('photos', 'f2000000-0000-7000-8000-00000000000f/full.jpg', '20000000-0000-4000-8000-000000000002')$$),
  '42501',
  'B cannot place a photo at an id A''s box names'
);
insert into public.products (cabinet_id, id, name, photo_id) values
  ('20000000-0000-4000-8000-000000000002', 'd3000000-0000-7000-8000-00000000000d', 'Parol', 'f0000000-0000-7000-8000-00000000000f');
select is(
  (select photo_id from public.products where id = 'd3000000-0000-7000-8000-00000000000d'),
  null::uuid,
  'nor name a photo it cannot read to read it: an id once seen is not a key'
);
select lives_ok(
  $$insert into storage.objects (bucket_id, name, owner_id) values
    ('photos', 'f3000000-0000-7000-8000-00000000000f/full.jpg', '20000000-0000-4000-8000-000000000002')$$,
  'B places a photo no row names yet: the app sends it before its row'
);
select is(
  pg_temp.exec_sqlstate($$update storage.objects set name = 'f2000000-0000-7000-8000-00000000000f/full.jpg'
    where bucket_id = 'photos' and name = 'f3000000-0000-7000-8000-00000000000f/full.jpg'$$),
  '42501',
  'nor moves it to an id A''s box names: a move is an update'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select is(
  (select count(*) from public.own_photo_objects()),
  2::bigint,
  'A''s own photos are listed for its deletion'
);
select lives_ok(
  $$insert into storage.objects (bucket_id, name, owner_id) values
    ('photos', 'f2000000-0000-7000-8000-00000000000f/full.jpg', '10000000-0000-4000-8000-000000000001')$$,
  'A places the photo its own box names'
);
select is((select count(*) from public.unnamed_photos()), 0::bigint, 'a photo no row names is kept while it is new');
set local role postgres;
update storage.objects set created_at = now() - interval '31 days' where bucket_id = 'photos';
set local role authenticated;
select is(
  (select array_agg(n) from public.unnamed_photos() n),
  array['f1000000-0000-7000-8000-00000000000f/full.jpg'],
  'a month on, the uploader is given the one no row names to remove'
);
set local role postgres;
select is(
  pg_temp.exec_sqlstate($$insert into storage.objects (bucket_id, name, owner_id, metadata) values
    ('photos', 'f5000000-0000-7000-8000-00000000000f/full.jpg', '20000000-0000-4000-8000-000000000002', '{"size": 104857601}')$$),
  '42501',
  'an account''s photos weigh 100 MB at most, as Storage writes them'
);
select is(private.photo_of_object('../f0000000-0000-7000-8000-00000000000f/full.jpg'), null::uuid, 'a path that climbs names no photo');

select * from extensions.finish();
rollback;
