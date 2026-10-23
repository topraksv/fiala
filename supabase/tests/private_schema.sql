-- The `private` schema (migration 1): where the helpers a policy calls live,
-- so PostgREST never serves them: today the cabinet's (migrations 2 and 4).
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
  (select count(*) from pg_namespace where nspname = 'private'),
  1::bigint,
  'the schema exists'
);
select ok(has_schema_privilege('authenticated', 'private', 'USAGE'), 'a signed-in request may enter it, since a policy runs as the requester');
select ok(not has_schema_privilege('anon', 'private', 'USAGE'), 'a signed-out one may not');
select is(
  (select count(*) from pg_proc p where p.pronamespace = 'private'::regnamespace
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('public', p.oid, 'EXECUTE'))),
  0::bigint,
  'no helper in it is open to the signed-out or to the public'
);
select is(
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('can_read_cabinet', 'can_write_cabinet') ),
  0::bigint,
  'and none of them is in the exposed schema'
);
select is(
  (select count(*) from pg_proc p where p.pronamespace = 'private'::regnamespace
     and p.proname in ('can_read_cabinet', 'can_write_cabinet')),
  2::bigint,
  'the cabinet''s helpers are here'
);

select * from extensions.finish();
rollback;
