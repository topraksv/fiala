-- Türkiye's pharmacies from OpenStreetMap (docs/TASKS.md F5.6a): read by
-- every signed-in person, written only by `catalogue.yml`'s pharmacy job with
-- the service-role key. Not a synced table: no device keeps a copy, so
-- nothing here meets `sync_cursors()` or a reset.
--
-- The client asks by place or by a box of map, never by its position: the box
-- it sends is rounded and wider than where it stands, and the distance to
-- each pharmacy is measured on the device (docs/PRIVACY.md).

begin;

create table public.pharmacies (
  -- OpenStreetMap's own: "node/123", which also links the place to correct it.
  id text primary key check (id ~ '^(node|way|relation)/[0-9]+$'),
  -- 321 of 25,365 carry none (24.10.2026); the screen names them for what they are.
  name text check (length(name) between 1 and 200),
  province text not null check (length(province) between 1 and 80),
  district text check (length(district) <= 80),
  neighbourhood text check (length(neighbourhood) <= 120),
  address text check (length(address) <= 300),
  phone text check (length(phone) <= 60),
  opening_hours text check (length(opening_hours) <= 300),
  lat double precision not null check (lat between 35 and 43),
  lon double precision not null check (lon between 25 and 45),
  -- The day of the load that last saw it: what the screen cites as updated.
  seen_on date not null
);

create index pharmacies_place on public.pharmacies (province, district);
create index pharmacies_position on public.pharmacies (lat, lon);

alter table public.pharmacies enable row level security;
create policy pharmacies_read on public.pharmacies for select to authenticated using (true);
create policy pharmacies_service_role on public.pharmacies for all to service_role using (true) with check (true);

revoke all on table public.pharmacies from anon, authenticated;
grant select on table public.pharmacies to authenticated;
grant all on table public.pharmacies to service_role;

-- Every province and district that has a pharmacy, for choosing a place by hand.
create function public.pharmacy_places()
returns table (province text, district text, pharmacies bigint)
language sql
stable
set search_path = ''
as $$
  select p.province, p.district, count(*)
    from public.pharmacies p
   group by p.province, p.district
   order by p.province collate "tr-TR-x-icu", p.district collate "tr-TR-x-icu"
$$;

-- A district's pharmacies, by name; 529 in the largest (Çankaya, 24.10.2026).
create function public.pharmacies_of(province text, district text, max_rows int default 600)
returns setof public.pharmacies
language sql
stable
set search_path = ''
as $$
  select p.* from public.pharmacies p
   where p.province = pharmacies_of.province
     and p.district is not distinct from pharmacies_of.district
   order by p.name collate "tr-TR-x-icu", p.id
   limit least(greatest(max_rows, 1), 600)
$$;

-- A box of map no larger than a degree a side, its middle first: the client
-- sorts by distance itself, and the limit drops the far corners, not the near.
create function public.pharmacies_in(south double precision, west double precision, north double precision, east double precision, max_rows int default 300)
returns setof public.pharmacies
language sql
stable
set search_path = ''
as $$
  select p.* from public.pharmacies p
   where north - south between 0 and 1
     and east - west between 0 and 1
     and p.lat between south and north
     and p.lon between west and east
   order by power(p.lat - (south + north) / 2, 2) + power((p.lon - (west + east) / 2) * cos(radians((south + north) / 2)), 2), p.id
   limit least(greatest(max_rows, 1), 300)
$$;

-- The ones a person starred or opened, by id, at most fifty.
create function public.pharmacies_by_id(ids text[])
returns setof public.pharmacies
language sql
stable
set search_path = ''
as $$
  select p.* from public.pharmacies p where p.id = any (ids[1:50]) order by p.id
$$;

revoke all on function public.pharmacy_places() from public, anon;
revoke all on function public.pharmacies_by_id(text[]) from public, anon;
grant execute on function public.pharmacies_by_id(text[]) to authenticated;
revoke all on function public.pharmacies_of(text, text, int) from public, anon;
revoke all on function public.pharmacies_in(double precision, double precision, double precision, double precision, int) from public, anon;
grant execute on function public.pharmacy_places() to authenticated;
grant execute on function public.pharmacies_of(text, text, int) to authenticated;
grant execute on function public.pharmacies_in(double precision, double precision, double precision, double precision, int) to authenticated;

commit;
