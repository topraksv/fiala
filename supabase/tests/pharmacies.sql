-- The pharmacies (migration 17): every signed-in person reads them by place
-- or by a box of map, only the service role writes them.
begin;

set local role postgres;
set local search_path = extensions, public, pg_catalog;

select extensions.plan(12);

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

set local role service_role;
-- A loaded table stays out of it; the rollback brings it back.
delete from public.pharmacies;
insert into public.pharmacies (id, name, province, district, lat, lon, seen_on) values
  ('node/1', 'Zeren Eczanesi', 'İstanbul', 'Kadıköy', 40.990, 29.030, '2026-10-24'),
  ('node/2', 'Çınar Eczanesi', 'İstanbul', 'Kadıköy', 40.980, 29.060, '2026-10-24'),
  ('way/3', 'Ilgaz Eczanesi', 'İstanbul', 'Kadıköy', 41.200, 29.030, '2026-10-24'),
  ('node/4', null, 'İzmir', 'Çeşme', 38.320, 26.300, '2026-10-24');

select ok((select relrowsecurity from pg_class where oid = 'public.pharmacies'::regclass), 'the pharmacies have row-level security on');

set local role anon;
select is(pg_temp.exec_sqlstate($$select * from public.pharmacies$$), '42501', 'a signed-out request cannot read them');
select is(pg_temp.exec_sqlstate($$select public.pharmacies_in(40, 29, 41, 30)$$), '42501', 'or ask by a box of map');

set local role authenticated;
select is(pg_temp.exec_sqlstate($$insert into public.pharmacies (id, province, lat, lon, seen_on) values ('node/9', 'X', 40, 30, '2026-10-24')$$), '42501', 'a signed-in request cannot add one');
select is(pg_temp.exec_sqlstate($$update public.pharmacies set name = 'X'$$), '42501', 'or change one');
select is(pg_temp.exec_sqlstate($$delete from public.pharmacies$$), '42501', 'or remove one');

select is((select array_agg(province || '/' || district || '/' || pharmacies) from public.pharmacy_places()), array['İstanbul/Kadıköy/3', 'İzmir/Çeşme/1'], 'the places with how many each, in Turkish order');
select is((select array_agg(id) from public.pharmacies_of('İstanbul', 'Kadıköy')), array['node/2', 'way/3', 'node/1'], 'a district''s by name in Turkish order: Ç after C, I before İ');
select is((select array_agg(id) from public.pharmacies_in(40.9, 28.9, 41.1, 29.1)), array['node/1', 'node/2'], 'a box''s, its middle first, nothing outside it');
select is((select array_agg(id) from public.pharmacies_in(40.9, 28.9, 41.1, 29.1, 1)), array['node/1'], 'and a limit drops the far ones');
select is((select count(*) from public.pharmacies_in(30, 20, 45, 45)), 0::bigint, 'a box larger than a degree a side finds nothing');

select is((select array_agg(id) from public.pharmacies_by_id(array['node/4', 'node/1', 'node/9'])), array['node/1', 'node/4'], 'the ones asked for by id that are still there');

select * from extensions.finish();
rollback;
