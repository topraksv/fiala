-- The heartbeat (migration 1): `keepalive.yml` writes it with the service-role
-- key, and no client role may touch it.
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


insert into public.keep_alive (id) values (1);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.keep_alive'::regclass),
  'keep_alive has row-level security on'
);

set local role anon;
select is(pg_temp.exec_sqlstate($$select * from public.keep_alive$$), '42501', 'a signed-out request cannot read it');
set local role authenticated;
select is(pg_temp.exec_sqlstate($$select * from public.keep_alive$$), '42501', 'a signed-in request cannot read it');
select is(pg_temp.exec_sqlstate($$insert into public.keep_alive (id) values (2)$$), '42501', 'or write it');

set local role service_role;
select lives_ok(
  $$insert into public.keep_alive (id) values (2) on conflict (id) do update set pinged_at = now()$$,
  'the service role upserts its row'
);
select is((select count(*) from public.keep_alive), 2::bigint, 'and reads it back');

select * from extensions.finish();
rollback;
