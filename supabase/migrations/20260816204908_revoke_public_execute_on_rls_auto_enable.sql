-- Close the pre-existing advisory (flagged in SETUP.md): public.rls_auto_enable()
-- is a SECURITY DEFINER function reachable from the public REST API via
-- /rest/v1/rpc/rls_auto_enable by both anon and authenticated.
--
-- It is an EVENT-TRIGGER function (wired to the `ensure_rls` trigger on
-- ddl_command_end) that auto-enables RLS on newly created public tables. It is
-- never meant to be invoked directly by API clients. Event triggers fire via the
-- trigger mechanism regardless of EXECUTE grants, so revoking EXECUTE from the
-- API roles removes it from the public API without affecting the auto-RLS guard.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
