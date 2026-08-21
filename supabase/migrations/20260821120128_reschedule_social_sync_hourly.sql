-- Move the social sync from once-daily (03:15) to hourly (:15 past every hour),
-- and rename the job from social-sync-daily to social-sync-hourly to match.
--
-- pg_cron has no rename, so we unschedule the old name and reschedule under the
-- new one with the same command. Idempotent: safe to re-run.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'social-sync-daily') then
    perform cron.unschedule('social-sync-daily');
  end if;
  if exists (select 1 from cron.job where jobname = 'social-sync-hourly') then
    perform cron.unschedule('social-sync-hourly');
  end if;
end $$;

select cron.schedule('social-sync-hourly', '15 * * * *', $cmd$
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
$cmd$);
