-- Nothing had privileges on the social schema, not even service_role. Two consequences:
--   1. Edge functions could not read or write social.* through PostgREST at all.
--   2. The public.social_* views are security_invoker, so they check the *caller's*
--      rights on the underlying tables. Authenticated users had none, so the dashboard
--      would have failed too. It only looked fine earlier because it was tested as
--      postgres, which bypasses all of this.

-- service_role does the collecting: full access, including to future tables.
grant usage on schema social to service_role;
grant all privileges on all tables    in schema social to service_role;
grant all privileges on all sequences in schema social to service_role;
alter default privileges in schema social grant all privileges on tables    to service_role;
alter default privileges in schema social grant all privileges on sequences to service_role;

-- Signed-in users read only what the public views need. RLS still applies on top;
-- this grant is the floor, the policies are the ceiling.
grant usage on schema social to authenticated;
grant select on
  social.accounts,
  social.account_snapshots,
  social.daily_metrics,
  social.posts,
  social.post_metrics,
  social.sync_runs
to authenticated;

-- Deliberately NOT granted to anyone but service_role:
--   social.credentials  — OAuth tokens
--   social.oauth_states — CSRF state
-- These now have two independent locks: no table grant, and RLS enabled with no policies.

-- anon gets nothing at all. No usage on the schema, no table rights.
revoke all on schema social from anon;

-- Sequences behind the identity columns authenticated never writes to.
revoke all on all sequences in schema social from authenticated, anon;
