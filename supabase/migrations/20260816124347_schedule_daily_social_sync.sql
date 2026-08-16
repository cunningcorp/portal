-- Daily sync at 03:15 UTC (07:15 Dubai): late enough that YouTube's analytics for the
-- previous day have settled, early enough to be there before anyone looks.
--
-- Two things learned by running this by hand rather than waiting for the schedule:
--
-- 1. pg_net defaults to a 5 second timeout. A full run across four collectors takes
--    around 40 seconds. The edge function keeps going after pg_net hangs up, so the
--    data still lands — but the response is lost and net._http_response records a
--    timeout instead of the result, which would make a failing sync indistinguishable
--    from a working one. timeout_milliseconds is set to 120s so the result is captured.
--
-- 2. The service role key is read from Vault by name rather than embedded here, so this
--    migration carries no secret and can live in the repo. Create it once with:
--      select vault.create_secret('<key>', 'signal_service_role_key', 'daily sync cron');

select cron.schedule(
  'social-sync-daily',
  '15 3 * * *',
  $job$
  select net.http_post(
    url                  := 'https://qeafetctmtnqonhwhhlw.supabase.co/functions/v1/sync-all',
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
