-- The medicine catalogue (migration 16): every signed-in person reads and
-- searches it, only the service role writes it, and its search folds Turkish
-- as the app's own search does.
begin;

set local role postgres;
set local search_path = extensions, public, pg_catalog;

select extensions.plan(20);

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
-- A loaded list stays out of it; the rollback brings it back.
delete from public.catalogue_products;
insert into public.catalogue_products (id, gtin, name, active_substance, atc, holder, suspended, listed_on) values
  (repeat('a', 40), '08699508010752', 'ONADRON 0.75 MG TABLET, 100 TABLET', 'dekzametazon', 'H02AB02', 'MENARİNİ SAĞLIK', false, '2026-10-23'),
  (repeat('b', 40), '08680150350112', 'AKNEFLOKS %1 KREM, 30 G', 'nadifloksasin', 'D10AF05', 'BERAT BERAN İLAÇ', false, '2026-10-23'),
  (repeat('c', 40), '08680150350112', 'Nimejel Plus %1+ %5 Jel, 50 G', 'Nimesulid, Lidokain', 'M02AA26', 'BERKO İLAÇ', true, '2026-10-23'),
  (repeat('d', 40), null, 'İBUPROFEN 400 MG FİLM TABLET, 20 TABLET', 'ibuprofen', 'M01AE01', 'ATABAY KİMYA', false, '2026-10-23'),
  (repeat('e', 40), '08681291150456', 'ADVIL LIQUI-GELS 200 MG KAPSUL, 20 ADET', 'ibuprofen', 'M01AE01', 'HALEON', false, '2026-10-23');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.catalogue_products'::regclass),
  'the catalogue has row-level security on'
);
select is((select search_key from public.catalogue_products where id = repeat('d', 40)),
  'ibuprofen 400 mg film tablet, 20 tablet ibuprofen atabay kimya', 'its key folds Turkish case and marks, and a missing barcode adds nothing');

set local role anon;
select is(pg_temp.exec_sqlstate($$select * from public.catalogue_products$$), '42501', 'a signed-out request cannot read it');
select is(pg_temp.exec_sqlstate($$select public.search_catalogue('onadron')$$), '42501', 'or search it');
select is(pg_temp.exec_sqlstate($$select public.catalogue_entry(repeat('a', 40))$$), '42501', 'or open an entry');
select is(pg_temp.exec_sqlstate($$select public.catalogue_related(repeat('a', 40))$$), '42501', 'or its relatives');

set local role authenticated;
select is((select count(*) from public.catalogue_products), 5::bigint, 'a signed-in request reads every row');
select is(pg_temp.exec_sqlstate($$insert into public.catalogue_products (id, name, listed_on) values (repeat('f', 40), 'X', '2026-10-23')$$), '42501', 'but cannot add one');
select is(pg_temp.exec_sqlstate($$update public.catalogue_products set name = 'X'$$), '42501', 'change one');
select is(pg_temp.exec_sqlstate($$delete from public.catalogue_products$$), '42501', 'or remove one');

select is((select array_agg(id order by id) from public.search_catalogue('IBUPROFEN 400')), array[repeat('d', 40)], 'every word typed, any case, finds the row');
select is((select array_agg(id) from public.search_catalogue('ibuprofen')), array[repeat('d', 40), repeat('e', 40)], 'a name that begins with it comes before a substance that contains it');
select is((select array_agg(id order by id) from public.search_catalogue('kimya ibuprofen')), array[repeat('d', 40)], 'in any order, the holder too');
select is((select array_agg(id) from public.search_catalogue('8680150350112')), array[repeat('b', 40), repeat('c', 40)], 'a printed barcode finds both products the list gives it, a suspended one last');
select is((select array_agg(id) from public.search_catalogue('onadorn')), array[repeat('a', 40)], 'a word a slip away still finds it');
select is((select array_agg(id) from public.search_catalogue('%')), array[repeat('b', 40), repeat('c', 40)], 'a typed wildcard is a character: it finds the strengths written with it, not everything');
select is((select count(*) from public.search_catalogue('   ')), 0::bigint, 'and nothing typed finds nothing');

set local role service_role;
insert into public.catalogue_products (id, gtin, name, active_substance, atc, holder, suspended, listed_on) values
  (repeat('f', 40), null, 'ADVIL 400 MG FİLM TABLET, 20 TABLET', 'İBUPROFEN', 'M01AE01', 'HALEON', true, '2026-10-23');
set local role authenticated;
select is((select array_agg(id) from public.catalogue_entry(repeat('e', 40))), array[repeat('e', 40)], 'an entry opens by its id');
select is((select array_agg(id) from public.catalogue_related(repeat('e', 40))), array[repeat('f', 40), repeat('d', 40)],
  'its relatives: the same name in another strength first, suspended or not, then the same substance folded, never itself');
select is((select count(*) from public.catalogue_related(repeat('a', 40))), 0::bigint, 'an entry alone in the list has none');

select * from extensions.finish();
rollback;
