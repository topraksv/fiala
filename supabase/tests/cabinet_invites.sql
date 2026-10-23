-- Invitations into a household (migration 6): a link works once, for seven
-- days, and is stored only as its hash; an offer reaches only someone the
-- owner already shares a household with; the personal cabinet is never
-- shared. As Gital's sharing and list offers are asserted.
begin;

set local role postgres;
set local search_path = extensions, public, pg_catalog;

select extensions.plan(49);

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

create function pg_temp.as_user(person uuid)
returns void
language sql
as $$ select set_config('request.jwt.claim.sub', person::text, true) $$;

-- A owns two households, H and K; B, C and D join or are asked.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       'fiala-invite-' || u.n || '@example.invalid', '', now(),
       '{"provider":"email","providers":["email"]}', '{}', now(), now()
  from (values ('a', '10000000-0000-4000-8000-000000000001'::uuid),
               ('b', '20000000-0000-4000-8000-000000000002'::uuid),
               ('c', '30000000-0000-4000-8000-000000000003'::uuid),
               ('d', '40000000-0000-4000-8000-000000000004'::uuid)) as u (n, id);

create temp table tokens (who text primary key, token text);
grant all on table tokens to authenticated;

select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'cabinet_invites' and grantee in ('anon', 'authenticated')),
  0::bigint,
  'no client role reads or writes an invitation'
);
select is(
  (select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'definers')
      and p.proname in ('create_cabinet_invite', 'cancel_cabinet_invites', 'peek_cabinet_invite', 'accept_cabinet_invite',
                        'offer_cabinet', 'cabinet_offers', 'answer_cabinet_offer')
      and has_function_privilege('anon', p.oid, 'execute')),
  null,
  'signed out, nobody calls any of the invitation functions'
);

-- A, the owner.
select pg_temp.as_user('10000000-0000-4000-8000-000000000001');
set local role authenticated;

select is(
  pg_temp.exec_sqlstate($$select public.create_cabinet_invite('c0000000-0000-7000-8000-00000000000c', 'editor', 'Ömer')$$),
  '42501',
  'a household the server does not hold yet is refused as not the owner''s, so the device sends it and asks again'
);
insert into public.cabinets (id, owner_id, name) values
  ('c0000000-0000-7000-8000-00000000000c', '10000000-0000-4000-8000-000000000001', 'Ev'),
  ('c0000000-0000-7000-8000-0000000000cc', '10000000-0000-4000-8000-000000000001', 'Annemler');
insert into public.products (cabinet_id, id, name) values
  ('c0000000-0000-7000-8000-00000000000c', 'a1000000-0000-7000-8000-00000000000a', 'Parol');
select is(
  pg_temp.exec_sqlstate($$select public.create_cabinet_invite('10000000-0000-4000-8000-000000000001', 'editor', 'Ömer')$$),
  'FA001',
  'the personal cabinet is never shared'
);
select is(
  pg_temp.exec_sqlstate($$select public.create_cabinet_invite('c0000000-0000-7000-8000-00000000000c', 'owner', 'Ömer')$$),
  '22023',
  'a link makes an editor or a viewer, never another owner'
);
insert into tokens values ('B', public.create_cabinet_invite('c0000000-0000-7000-8000-00000000000c', 'editor', 'Ömer'));
insert into tokens values ('C', public.create_cabinet_invite('c0000000-0000-7000-8000-00000000000c', 'viewer', 'Ömer'));
select ok((select bool_and(token ~ '^[0-9a-f]{64}$') from tokens), 'a link''s token is two random UUIDs, as hex');
select is(
  (select name from public.cabinet_members where user_id = '10000000-0000-4000-8000-000000000001'),
  'Ömer',
  'the owner joins the household''s members under the name they gave'
);

set local role postgres;
select is(
  (select count(*) from public.cabinet_invites i join tokens t on i.token_hash = encode(sha256(convert_to(t.token, 'UTF8')), 'hex')),
  2::bigint,
  'each link is stored as its SHA-256'
);
select is(
  (select count(*) from public.cabinet_invites i join tokens t on i.token_hash = t.token),
  0::bigint,
  'and never as itself'
);
select ok(
  (select bool_and(expires_at between now() + interval '7 days' - interval '1 minute' and now() + interval '7 days') from public.cabinet_invites),
  'for seven days'
);

-- B, invited.
select pg_temp.as_user('20000000-0000-4000-8000-000000000002');
set local role authenticated;

select is(
  pg_temp.exec_sqlstate($$select public.create_cabinet_invite('c0000000-0000-7000-8000-00000000000c', 'editor', 'B')$$),
  '42501',
  'only the owner invites'
);
select is(
  (select row(name, inviter, role)::text from public.peek_cabinet_invite((select token from tokens where who = 'B'))),
  '(Ev,Ömer,editor)',
  'a link shows what it opens, who sent it and as what, before it is used'
);
select is((select count(*) from public.products), 0::bigint, 'looking lets nobody in');
select is(
  pg_temp.exec_sqlstate($$select public.accept_cabinet_invite('0000000000000000000000000000000000000000000000000000000000000000', 'B')$$),
  '22023',
  'a token nobody issued is refused'
);
select is(
  public.accept_cabinet_invite((select token from tokens where who = 'B'), 'Eda'),
  'c0000000-0000-7000-8000-00000000000c'::uuid,
  'a link lets its person in, and says where'
);
select is(
  (select row(role, name)::text from public.cabinet_members where user_id = '20000000-0000-4000-8000-000000000002'),
  '(editor,Eda)',
  'as the role it was made for, under the name they chose'
);
select is((select count(*) from public.products), 1::bigint, 'and the household is theirs to read');
select is(
  (select max_id from public.sync_cursors() where table_name = 'offers'),
  null,
  'no offer waits on someone nobody asked'
);

-- C tries B's spent link, then uses its own.
select pg_temp.as_user('30000000-0000-4000-8000-000000000003');
set local role authenticated;

select is(
  pg_temp.exec_sqlstate($$select public.accept_cabinet_invite((select token from tokens where who = 'B'), 'Can')$$),
  '22023',
  'a link works once'
);
select is((select count(*) from public.peek_cabinet_invite((select token from tokens where who = 'B'))), 0::bigint, 'and shows nothing once used');
select is(
  public.accept_cabinet_invite((select token from tokens where who = 'C'), 'Can'),
  'c0000000-0000-7000-8000-00000000000c'::uuid,
  'C joins'
);
select is((select role from public.cabinet_members where user_id = '30000000-0000-4000-8000-000000000003'), 'viewer', 'as a viewer');

-- Expired, and taken back.
select pg_temp.as_user('10000000-0000-4000-8000-000000000001');
set local role authenticated;
insert into tokens values ('late', public.create_cabinet_invite('c0000000-0000-7000-8000-00000000000c', 'editor', 'Ömer'));
set local role postgres;
update public.cabinet_invites set expires_at = now() - interval '1 second';
select pg_temp.as_user('40000000-0000-4000-8000-000000000004');
set local role authenticated;
select is((select count(*) from public.peek_cabinet_invite((select token from tokens where who = 'late'))), 0::bigint, 'a link past its seven days shows nothing');
select is(
  pg_temp.exec_sqlstate($$select public.accept_cabinet_invite((select token from tokens where who = 'late'), 'Deniz')$$),
  '22023',
  'a link past its seven days is refused'
);
select is((select count(*) from public.cabinet_members where user_id = '40000000-0000-4000-8000-000000000004'), 0::bigint, 'and lets nobody in');

select pg_temp.as_user('10000000-0000-4000-8000-000000000001');
set local role authenticated;
update public.cabinet_members set role = 'owner' where user_id = '30000000-0000-4000-8000-000000000003';
select is((select role from public.cabinet_members where user_id = '30000000-0000-4000-8000-000000000003'), 'viewer', 'a household has one owner: nobody is raised to it');
insert into tokens values ('D1', public.create_cabinet_invite('c0000000-0000-7000-8000-00000000000c', 'editor', 'Ömer'));
insert into tokens values ('D2', public.create_cabinet_invite('c0000000-0000-7000-8000-00000000000c', 'viewer', 'Ömer'));
select pg_temp.as_user('20000000-0000-4000-8000-000000000002');
select is(public.cancel_cabinet_invites('c0000000-0000-7000-8000-00000000000c'), 0, 'a member takes back no one''s links');
select pg_temp.as_user('10000000-0000-4000-8000-000000000001');
select is(public.cancel_cabinet_invites('c0000000-0000-7000-8000-00000000000c'), 2, 'the owner takes back every link not yet used');
select pg_temp.as_user('40000000-0000-4000-8000-000000000004');
select is(
  pg_temp.exec_sqlstate($$select public.accept_cabinet_invite((select token from tokens where who = 'D1'), 'Deniz')$$),
  '22023',
  'and a link taken back lets nobody in'
);

-- Offers: A asks C, who shares H with A, into K.
select pg_temp.as_user('10000000-0000-4000-8000-000000000001');
select is(
  pg_temp.exec_sqlstate($$select public.offer_cabinet('c0000000-0000-7000-8000-0000000000cc', '40000000-0000-4000-8000-000000000004', 'editor', 'Ömer')$$),
  'FA003',
  'an offer reaches only someone who shares a household with the owner'
);
select is(
  pg_temp.exec_sqlstate($$select public.offer_cabinet('c0000000-0000-7000-8000-00000000000c', '20000000-0000-4000-8000-000000000002', 'editor', 'Ömer')$$),
  'FA002',
  'nor anyone already in it'
);
select is(
  pg_temp.exec_sqlstate($$select public.offer_cabinet('c0000000-0000-7000-8000-0000000000cc', '10000000-0000-4000-8000-000000000001', 'editor', 'Ömer')$$),
  '22023',
  'nor the owner'
);
select public.offer_cabinet('c0000000-0000-7000-8000-0000000000cc', '30000000-0000-4000-8000-000000000003', 'viewer', 'Ömer');
select public.offer_cabinet('c0000000-0000-7000-8000-0000000000cc', '30000000-0000-4000-8000-000000000003', 'editor', 'Ömer');
select is(
  (select array_agg(row(cabinet_name, role, from_name)::text) from public.cabinet_offers()),
  array['(Annemler,editor,Ömer)'],
  'the owner sees the offer made, once, at the role last chosen'
);

select pg_temp.as_user('20000000-0000-4000-8000-000000000002');
select is((select count(*) from public.cabinet_offers()), 0::bigint, 'nobody else does');
select is(
  pg_temp.exec_sqlstate($$select public.answer_cabinet_offer('c0000000-0000-7000-8000-0000000000cc', true, 'Eda')$$),
  '22023',
  'nor can answer it'
);
select is(
  pg_temp.exec_sqlstate($$select public.offer_cabinet('c0000000-0000-7000-8000-00000000000c', '40000000-0000-4000-8000-000000000004', 'editor', 'Eda')$$),
  '42501',
  'a member offers no one the household'
);
select public.offer_cabinet('c0000000-0000-7000-8000-0000000000cc', '30000000-0000-4000-8000-000000000003', null, 'Eda');

select pg_temp.as_user('30000000-0000-4000-8000-000000000003');
select is((select count(*) from public.cabinet_offers()), 1::bigint, 'nor withdraws another''s offer');
select isnt((select max_id from public.sync_cursors() where table_name = 'offers'), null, 'the change probe tells C an offer waits');
select is(public.answer_cabinet_offer('c0000000-0000-7000-8000-0000000000cc', false, 'Can'), null, 'C declines');
select is((select count(*) from public.cabinet_offers()), 0::bigint, 'and the offer is gone, leaving no record');
select is((select max_id from public.sync_cursors() where table_name = 'offers'), null, 'the probe says so');

select pg_temp.as_user('10000000-0000-4000-8000-000000000001');
select public.offer_cabinet('c0000000-0000-7000-8000-0000000000cc', '30000000-0000-4000-8000-000000000003', 'viewer', 'Ömer');
select public.offer_cabinet('c0000000-0000-7000-8000-0000000000cc', '30000000-0000-4000-8000-000000000003', null, 'Ömer');
select is((select count(*) from public.cabinet_offers()), 0::bigint, 'the owner withdraws an offer with no role');
select public.offer_cabinet('c0000000-0000-7000-8000-0000000000cc', '30000000-0000-4000-8000-000000000003', 'viewer', 'Ömer');

select pg_temp.as_user('30000000-0000-4000-8000-000000000003');
select is(
  public.answer_cabinet_offer('c0000000-0000-7000-8000-0000000000cc', true, 'Can'),
  'c0000000-0000-7000-8000-0000000000cc'::uuid,
  'C accepts the offer made again'
);
select is(
  (select role from public.cabinet_members where cabinet_id = 'c0000000-0000-7000-8000-0000000000cc' and user_id = '30000000-0000-4000-8000-000000000003'),
  'viewer',
  'and is in, as offered'
);

-- A removed member comes back only by a new invitation.
select pg_temp.as_user('10000000-0000-4000-8000-000000000001');
update public.cabinet_members set deleted_at = now() where user_id = '20000000-0000-4000-8000-000000000002';
insert into tokens values ('back', public.create_cabinet_invite('c0000000-0000-7000-8000-00000000000c', 'viewer', 'Ömer'));
select pg_temp.as_user('20000000-0000-4000-8000-000000000002');
select public.accept_cabinet_invite((select token from tokens where who = 'back'), 'Eda');
select is(
  (select row(role, deleted_at is null)::text from public.cabinet_members where user_id = '20000000-0000-4000-8000-000000000002'),
  '(viewer,t)',
  'a removed member let in again is a member again, at the new role'
);

-- A deleted household invites no one, and what it sent leads nowhere.
select pg_temp.as_user('10000000-0000-4000-8000-000000000001');
insert into tokens values ('gone', public.create_cabinet_invite('c0000000-0000-7000-8000-0000000000cc', 'editor', 'Ömer'));
select public.offer_cabinet('c0000000-0000-7000-8000-0000000000cc', '20000000-0000-4000-8000-000000000002', 'editor', 'Ömer');
update public.cabinets set deleted_at = now(), tombstone_version = 1 where id = 'c0000000-0000-7000-8000-0000000000cc';
select is(
  pg_temp.exec_sqlstate($$select public.create_cabinet_invite('c0000000-0000-7000-8000-0000000000cc', 'editor', 'Ömer')$$),
  '42501',
  'a deleted household invites no one'
);
select pg_temp.as_user('20000000-0000-4000-8000-000000000002');
select is((select count(*) from public.peek_cabinet_invite((select token from tokens where who = 'gone'))), 0::bigint, 'its link shows nothing');
select is(
  pg_temp.exec_sqlstate($$select public.accept_cabinet_invite((select token from tokens where who = 'gone'), 'Eda')$$),
  '22023',
  'nor lets anyone in'
);
select is(
  pg_temp.exec_sqlstate($$select public.answer_cabinet_offer('c0000000-0000-7000-8000-0000000000cc', true, 'Eda')$$),
  '22023',
  'nor does its offer'
);

select * from extensions.finish();
rollback;
