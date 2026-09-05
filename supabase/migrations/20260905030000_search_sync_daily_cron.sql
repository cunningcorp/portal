-- Search Signal — daily collector schedule. GSC data lags ~2-3 days, so hourly is pointless;
-- run sync-search once a day. Mirrors the existing social-sync-hourly job exactly: pg_cron ->
-- net.http_post to the function, authenticated with the service-role key from Vault (which
-- satisfies the function's verify_jwt). Empty body = the default trailing-30-day window (the
-- one-off 16-month backfill is a manual {days:480} call).
select cron.schedule(
  'search-sync-daily',
  '0 7 * * *',
  $job$
  select net.http_post(
    url                  := 'https://qeafetctmtnqonhwhhlw.supabase.co/functions/v1/sync-search',
    headers              := jsonb_build_object(
                              'Content-Type',  'application/json',
                              'Authorization', 'Bearer ' || (
                                 select decrypted_secret from vault.decrypted_secrets
                                 where name = 'signal_service_role_key')
                            ),
    body                 := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $job$
);
