-- The definers behind invokers (migration 1): what PostgREST exposes runs as
-- its caller. A definer a client role can execute belongs in `definers`,
-- behind an invoker of the same name.
begin;

set local role postgres;
set local search_path = extensions, public, pg_catalog;

select extensions.plan(6);

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


select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  0::bigint,
  'no exposed function runs as its owner for a client'
);
select is(
  (select count(*) from pg_proc d join pg_namespace n on n.oid = d.pronamespace
    where n.nspname = 'definers'
      and not exists (
        select 1 from pg_proc w
         where w.pronamespace = 'public'::regnamespace and w.proname = d.proname
           and w.proargtypes = d.proargtypes and not w.prosecdef)),
  0::bigint,
  'every definer has an invoker of the same name and arguments in public'
);
select is(
  (select count(*) from pg_proc where pronamespace = 'definers'::regnamespace and not prosecdef),
  0::bigint,
  'and everything in definers runs as its owner'
);
select is(
  (select count(*) from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'definers'::regnamespace, 'private'::regnamespace)
      and not exists (select 1 from pg_options_to_table(p.proconfig) o where o.option_name = 'search_path' and o.option_value in ('', '""'))
      and p.prokind = 'f'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')),
  0::bigint,
  'every function of ours pins an empty search path'
);
select ok(not has_schema_privilege('public', 'definers', 'USAGE'), 'the public may not enter definers');
select is(
  (select count(*) from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid)),
  0::bigint,
  'every table with RLS states who reaches its rows'
);

select * from extensions.finish();
rollback;
