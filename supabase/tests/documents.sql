-- Documents and their files (migration 14): who reads a document and its
-- file, who may name or place one, and what a move, the sweep and the budget
-- leave. Members are fixtures made as postgres, as in `sharing_rls.sql`.
begin;

set local role postgres;
set local search_path = extensions, public, pg_catalog;

select extensions.plan(19);

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

-- A owns the household H, B edits it, C views it, D is outside it.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       'fiala-doc-' || u.n || '@example.invalid', '', now(),
       '{"provider":"email","providers":["email"]}', '{}', now(), now()
  from (values ('a', '10000000-0000-4000-8000-000000000001'::uuid),
               ('b', '20000000-0000-4000-8000-000000000002'::uuid),
               ('c', '30000000-0000-4000-8000-000000000003'::uuid),
               ('d', '40000000-0000-4000-8000-000000000004'::uuid)) as u (n, id);

insert into public.cabinets (id, owner_id, name) values
  ('c0000000-0000-7000-8000-00000000000c', '10000000-0000-4000-8000-000000000001', 'Ev');
insert into public.cabinet_members (cabinet_id, user_id, role, name) values
  ('c0000000-0000-7000-8000-00000000000c', '10000000-0000-4000-8000-000000000001', 'owner', 'Ayşe'),
  ('c0000000-0000-7000-8000-00000000000c', '20000000-0000-4000-8000-000000000002', 'editor', 'Burak'),
  ('c0000000-0000-7000-8000-00000000000c', '30000000-0000-4000-8000-000000000003', 'viewer', 'Can');

-- A's prescription in the household, and A's lab result kept to A; A sent both files.
insert into public.documents (cabinet_id, id, kind, title, file_id, file_type, byte_size) values
  ('c0000000-0000-7000-8000-00000000000c', 'd1000000-0000-7000-8000-00000000000d', 'prescription', 'Reçete', 'f1000000-0000-7000-8000-00000000000f', 'pdf', 1000),
  ('10000000-0000-4000-8000-000000000001', 'd2000000-0000-7000-8000-00000000000d', 'lab', 'Tahlil', 'f2000000-0000-7000-8000-00000000000f', 'jpeg', 1000);
insert into storage.objects (bucket_id, name, owner_id) values
  ('documents', 'f1000000-0000-7000-8000-00000000000f/file.pdf', '10000000-0000-4000-8000-000000000001'),
  ('documents', 'f2000000-0000-7000-8000-00000000000f/file.jpg', '10000000-0000-4000-8000-000000000001');

-- D, outside.
select set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000004', true);
set local role authenticated;

select is((select count(*) from public.documents), 0::bigint, 'D reads no document of a cabinet it is not in');
select is((select count(*) from storage.objects where bucket_id = 'documents'), 0::bigint, 'nor any file');

-- C, a viewer.
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000003', true);
set local role authenticated;

select is(
  pg_temp.exec_sqlstate($$insert into public.documents (cabinet_id, id, kind, title) values
    ('c0000000-0000-7000-8000-00000000000c', 'd3000000-0000-7000-8000-00000000000d', 'other', 'X')$$),
  '42501',
  'a viewer adds no document to the household'
);
select is(
  pg_temp.exec_sqlstate($$insert into storage.objects (bucket_id, name, owner_id) values
    ('documents', 'f1000000-0000-7000-8000-00000000000f/file.jpg', '30000000-0000-4000-8000-000000000003')$$),
  '42501',
  'nor places a file at an id a household document names'
);

-- B, an editor.
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
set local role authenticated;

select is((select array_agg(title) from public.documents), array['Reçete'], 'an editor reads the household''s document, not what A keeps to A');
select is(
  (select array_agg(name) from storage.objects where bucket_id = 'documents'),
  array['f1000000-0000-7000-8000-00000000000f/file.pdf'],
  'and its file, not the other'
);
insert into public.documents (cabinet_id, id, kind, title, file_id, file_type, byte_size) values
  ('20000000-0000-4000-8000-000000000002', 'd4000000-0000-7000-8000-00000000000d', 'lab', 'Benim', 'f2000000-0000-7000-8000-00000000000f', 'jpeg', 1000);
select is(
  (select coalesce(file_id::text, '') || coalesce(file_type, '') || coalesce(byte_size::text, '') from public.documents where id = 'd4000000-0000-7000-8000-00000000000d'),
  '',
  'naming a file B cannot read keeps the row and drops the file: an id once seen is not a key'
);
select is(
  (select created_by from public.documents where id = 'd4000000-0000-7000-8000-00000000000d'),
  '20000000-0000-4000-8000-000000000002'::uuid,
  'the server names who added it'
);
insert into public.documents (cabinet_id, id, kind, title, file_id, file_type, byte_size) values
  ('20000000-0000-4000-8000-000000000002', 'd5000000-0000-7000-8000-00000000000d', 'prescription', 'Kopya', 'f1000000-0000-7000-8000-00000000000f', 'pdf', 1000);
select is(
  (select file_id from public.documents where id = 'd5000000-0000-7000-8000-00000000000d'),
  'f1000000-0000-7000-8000-00000000000f'::uuid,
  'one B reads through a live row it may name'
);
update public.documents set deleted_at = now() where id = 'd5000000-0000-7000-8000-00000000000d';
select is(
  pg_temp.exec_sqlstate($$insert into public.document_links (cabinet_id, id, document_id) values
    ('c0000000-0000-7000-8000-00000000000c', 'e1000000-0000-7000-8000-00000000000e', 'd1000000-0000-7000-8000-00000000000d')$$),
  '23514',
  'a link names a product or a box'
);
select lives_ok(
  $$insert into public.document_links (cabinet_id, id, document_id, package_id) values
    ('c0000000-0000-7000-8000-00000000000c', 'e1000000-0000-7000-8000-00000000000e', 'd1000000-0000-7000-8000-00000000000d', 'b1000000-0000-7000-8000-00000000000b')$$,
  'one, in any cabinet: the server does not look for it'
);

-- A moves the prescription out of the household: a tombstone stays there.
set local role postgres;
update public.documents set deleted_at = now(), title = '', file_id = null, file_type = null, byte_size = null where id = 'd1000000-0000-7000-8000-00000000000d';
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
set local role authenticated;

select is((select count(*) from storage.objects where bucket_id = 'documents'), 0::bigint, 'a file named only by tombstones is read by nobody but its owner');
insert into public.documents (cabinet_id, id, kind, title, file_id, file_type, byte_size) values
  ('20000000-0000-4000-8000-000000000002', 'd6000000-0000-7000-8000-00000000000d', 'prescription', 'Geri', 'f1000000-0000-7000-8000-00000000000f', 'pdf', 1000);
select is(
  (select file_id from public.documents where id = 'd6000000-0000-7000-8000-00000000000d'),
  null,
  'nor named back by one who read it there: a household a document left keeps nothing of it'
);
update public.documents set deleted_at = null where id = 'd1000000-0000-7000-8000-00000000000d';
select is((select count(*) from storage.objects where bucket_id = 'documents'), 0::bigint, 'nor by an editor bringing the tombstone back to life');

-- A.
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select is((select count(*) from storage.objects where bucket_id = 'documents'), 2::bigint, 'the owner reads every file they sent');
select is((select count(*) from public.own_document_objects()), 2::bigint, 'and lists them for the account''s deletion');
set local role postgres;
update storage.objects set created_at = now() - interval '31 days' where bucket_id = 'documents';
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
set local role authenticated;
select is(
  (select array_agg(n) from public.unnamed_documents() n),
  array['f1000000-0000-7000-8000-00000000000f/file.pdf'],
  'a month on, a file no live row names is swept, and one a live row names is kept'
);
select is(
  pg_temp.exec_sqlstate($$insert into storage.objects (bucket_id, name, owner_id, metadata) values
    ('documents', 'f9000000-0000-7000-8000-00000000000f/file.pdf', '10000000-0000-4000-8000-000000000001', '{"size": 209715201}')$$),
  '42501',
  'an account''s documents weigh 200 MB at most, as Storage writes them'
);
select is(private.document_of_object('../f1000000-0000-7000-8000-00000000000f/file.pdf'), null::uuid, 'a path that climbs names no document');

select * from extensions.finish();
rollback;
