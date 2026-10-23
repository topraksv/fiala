-- The linked project was created with Supabase's "enable RLS automatically"
-- option, which adds `public.rls_auto_enable()` behind the `ensure_rls` event
-- trigger. It is kept: every table here has RLS anyway. But it is a security
-- definer in the exposed schema that anon and members may execute, and the
-- advisor names it. An event trigger needs no one's EXECUTE to fire, so the
-- grant goes. A fresh or local database never had the function: nothing then.

begin;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke all on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;

commit;
