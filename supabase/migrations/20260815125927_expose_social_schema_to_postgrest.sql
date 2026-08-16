-- PostgREST only serves schemas listed in db-schemas. The edge functions talk to
-- social.* through PostgREST (supabase-js with db.schema = 'social'), so without this
-- every call fails with "Invalid schema: social" regardless of grants.
--
-- Captured as a migration so a rebuild reproduces it. Note that the Supabase dashboard
-- (Settings -> API -> Exposed schemas) writes the same setting: if anyone saves that
-- page without `social` in the list, it overwrites this. Keep the two in agreement.
--
-- Exposing the schema is safe here because access is controlled underneath it:
-- anon has no USAGE at all, authenticated has SELECT on six tables and nothing else,
-- and credentials/oauth_states are reachable only by service_role.

alter role authenticator set pgrst.db_schemas = 'public, graphql_public, social';

notify pgrst, 'reload config';
notify pgrst, 'reload schema';
