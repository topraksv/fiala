-- A deleted account's files are freed by `storage-sweep`.
--
-- Deleting an account removes every file it uploaded first, and then the
-- identity (`docs/PRIVACY.md`). Another device still signed in can upload
-- until its token expires, though, and SQL cannot free a blob: Storage's
-- `protect_delete` refuses a direct DELETE, and only the Storage API removes
-- the bytes. So the database names what goes and the edge function removes it
-- through that API, once a day.
--
-- What goes is what the app would have removed: an object whose uploader Auth
-- no longer holds. Deleting a user leaves `owner_id` on its objects (measured
-- on Helix's local stack), so the rule needs no folder layout. An object with
-- no uploader stays.
begin;

create function definers.swept_objects()
returns table (bucket_id text, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.bucket_id, o.name from storage.objects o
   where o.bucket_id in ('photos', 'documents') and o.owner_id is not null
     and not exists (select 1 from auth.users u where u.id::text = o.owner_id)
   order by o.name
   limit 1000;
$$;

create function public.swept_objects()
returns table (bucket_id text, name text)
language sql stable security invoker set search_path = ''
as $$ select * from definers.swept_objects() $$;

revoke all on function definers.swept_objects() from public, anon, authenticated, service_role;
revoke all on function public.swept_objects() from public, anon, authenticated, service_role;
grant execute on function definers.swept_objects() to service_role;
grant execute on function public.swept_objects() to service_role;

-- The function's address and its secret live in Vault as `storage_sweep_url`
-- and `storage_sweep_secret`, set on each project by hand (`docs/DELIVERY.md`):
-- a migration carries neither. Until both exist the job posts nothing.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'storage-sweep',
  '17 3 * * *',
  $$
    select net.http_post(
      url := url.decrypted_secret,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-sweep-secret', secret.decrypted_secret),
      body := '{}'::jsonb,
      -- pg_net's default is a few seconds; a first run with a backlog takes longer.
      timeout_milliseconds := 60000
    )
    from vault.decrypted_secrets url, vault.decrypted_secrets secret
    where url.name = 'storage_sweep_url' and secret.name = 'storage_sweep_secret'
  $$
);

commit;
