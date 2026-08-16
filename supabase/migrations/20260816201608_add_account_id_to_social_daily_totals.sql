-- Design handoff signal-2a, §6 request 1: add account_id to social_daily_totals.
--
-- The view was grouped by (day, platform, metric) only, so daily metrics could
-- not narrow to a single account even though social.daily_metrics carries
-- account_id. Grain becomes per-account; the frontend sums across accounts for
-- platform/overview scopes (verified: the cross-account sum reproduces the old
-- per-platform view exactly). security_invoker stays on so RLS on the underlying
-- tables still applies.
-- account_id is appended last: CREATE OR REPLACE VIEW can only add columns at
-- the end, and the frontend reads select("*") so column order does not matter.
create or replace view public.social_daily_totals with (security_invoker = on) as
select
  m.metric_date as day,
  a.platform,
  m.metric,
  sum(m.value)  as value,
  a.id          as account_id
from social.daily_metrics m
join social.accounts a on a.id = m.account_id
group by m.metric_date, a.platform, m.metric, a.id;
