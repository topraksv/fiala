-- The medicine catalogue (docs/TASKS.md F1.9): TİTCK's weekly list of
-- licensed human medicines, read by every signed-in person, written only by
-- `catalogue.yml` with the service-role key. It is not a synced table: no
-- device keeps a copy, so nothing here meets `sync_cursors()` or a reset.
--
-- One barcode can name two products in the list (53 did on 23.10.2026), and
-- some rows carry none, so the key is the row's own, `id`, which the import
-- derives from the barcode and the name: a lookup by barcode returns a list.

begin;

create extension if not exists pg_trgm with schema extensions;

-- Search folds as `foldName` in src/domain/boxes.ts does: Turkish case and
-- marks away, spacing collapsed, so "İBUPROFEN" and "ibuprofen" are one key.
-- `lower` on the mapped text, so `I` never becomes a dotless `ı` first.
create function private.catalogue_fold(text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select btrim(regexp_replace(
    lower(translate(text, 'İIıÇçŞşĞğÜüÖöÂâÎîÛû', 'iiiccssgguuooaaiiuu')),
    '\s+', ' ', 'g'))
$$;

create table public.catalogue_products (
  id text primary key check (id ~ '^[0-9a-f]{40}$'),
  -- GTIN-14 as `products.gtin` keeps it; null where the list's is missing or fails its check digit.
  gtin text check (gtin ~ '^[0-9]{14}$'),
  name text not null check (length(name) between 1 and 300),
  active_substance text check (length(active_substance) <= 600),
  atc text check (length(atc) <= 20),
  holder text check (length(holder) <= 300),
  -- TİTCK's column: 0 licensed, otherwise suspended on one of three grounds.
  suspended boolean not null default false,
  -- The date of the list the row was last seen in; the import drops rows an older list carried.
  listed_on date not null,
  search_key text generated always as (
    private.catalogue_fold(name || ' ' || coalesce(active_substance, '') || ' ' || coalesce(holder, '') || ' ' || coalesce(gtin, ''))
  ) stored
);

create index catalogue_products_gtin on public.catalogue_products (gtin);
create index catalogue_products_search on public.catalogue_products using gin (search_key extensions.gin_trgm_ops);

alter table public.catalogue_products enable row level security;
create policy catalogue_products_read on public.catalogue_products for select to authenticated using (true);
create policy catalogue_products_service_role on public.catalogue_products for all to service_role using (true) with check (true);

revoke all on table public.catalogue_products from anon, authenticated;
grant select on table public.catalogue_products to authenticated;
grant all on table public.catalogue_products to service_role;

-- Every word typed is in the row, in any order; where none is, rows a typo
-- away still come back, nearest first. A POST body, never a URL: what a
-- person searches for is health data and stays out of request logs.
create function public.search_catalogue(query text, max_rows int default 20)
returns setof public.catalogue_products
language sql
stable
set search_path = ''
-- `<%` reads it: half a word's trigrams in common, so the index serves the typo search.
set pg_trgm.word_similarity_threshold = 0.5
as $$
  with typed as (
    select private.catalogue_fold(query) as folded
  ),
  words as (
    select array_agg(replace(replace(replace(word, '\', '\\'), '%', '\%'), '_', '\_')) as each
      from typed, regexp_split_to_table(typed.folded, ' ') as word
     where word <> ''
  ),
  exact as (
    select c.*
      from public.catalogue_products c, words
     where words.each is not null
       and (select bool_and(c.search_key like '%' || w || '%') from unnest(words.each) as w)
  )
  select found.* from (
    select e.* from exact e
    union all
    select c.*
      from public.catalogue_products c, typed
     where not exists (select 1 from exact)
       and length(typed.folded) >= 4
       and typed.folded operator(extensions.<%) c.search_key
  ) found, typed
  -- Licensed first, then a name that begins with what was typed before a
  -- substance or holder that only contains it.
  order by found.suspended,
           starts_with(private.catalogue_fold(found.name), typed.folded) desc,
           extensions.word_similarity(typed.folded, found.search_key) desc,
           found.name
  limit least(greatest(max_rows, 1), 50)
$$;

-- One entry, and what a person comparing it wants beside it (F5.3): the same
-- first word of the name in another strength or form, then the same
-- substance under another name. Asked by POST as the search is: which
-- medicine a person opens is health data too.
create function public.catalogue_entry(entry_id text)
returns setof public.catalogue_products
language sql
stable
set search_path = ''
as $$
  select * from public.catalogue_products where id = entry_id
$$;

create index catalogue_products_brand on public.catalogue_products (split_part(search_key, ' ', 1));
create index catalogue_products_substance on public.catalogue_products (private.catalogue_fold(active_substance));

create function public.catalogue_related(entry_id text, max_rows int default 30)
returns setof public.catalogue_products
language sql
stable
set search_path = ''
as $$
  with this as (
    select split_part(search_key, ' ', 1) as brand, private.catalogue_fold(active_substance) as substance
      from public.catalogue_products where id = entry_id
  )
  select c.* from public.catalogue_products c, this
   where c.id <> entry_id
     and (split_part(c.search_key, ' ', 1) = this.brand or private.catalogue_fold(c.active_substance) = this.substance)
   order by split_part(c.search_key, ' ', 1) = this.brand desc, c.suspended, c.name
   limit least(greatest(max_rows, 1), 50)
$$;

revoke all on function public.search_catalogue(text, int) from public, anon;
grant execute on function public.search_catalogue(text, int) to authenticated;
revoke all on function public.catalogue_entry(text) from public, anon;
grant execute on function public.catalogue_entry(text) to authenticated;
revoke all on function public.catalogue_related(text, int) from public, anon;
grant execute on function public.catalogue_related(text, int) to authenticated;
revoke all on function private.catalogue_fold(text) from public, anon;
grant execute on function private.catalogue_fold(text) to authenticated, service_role;
-- The import writes as the service role, and the generated key calls the fold.
grant usage on schema private to service_role;

commit;
