-- Public read views for the portal frontend.
-- security_invoker = on so RLS on the underlying social.* tables still applies.

create or replace function social.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_accounts_updated_at on social.accounts;
create trigger trg_accounts_updated_at
  before update on social.accounts
  for each row execute function social.touch_updated_at();

-- ---------------------------------------------------------------
-- Account overview: latest totals + 7d / 28d deltas
-- ---------------------------------------------------------------
create or replace view public.social_accounts_overview
with (security_invoker = on) as
with latest as (
  select distinct on (account_id)
         account_id, captured_on, followers, total_posts, total_views, total_likes
  from social.account_snapshots
  order by account_id, captured_on desc
),
prev7 as (
  select distinct on (s.account_id)
         s.account_id, s.followers, s.total_views
  from social.account_snapshots s
  join latest l on l.account_id = s.account_id
  where s.captured_on <= l.captured_on - 7
  order by s.account_id, s.captured_on desc
),
prev28 as (
  select distinct on (s.account_id)
         s.account_id, s.followers, s.total_views
  from social.account_snapshots s
  join latest l on l.account_id = s.account_id
  where s.captured_on <= l.captured_on - 28
  order by s.account_id, s.captured_on desc
)
select
  a.id                            as account_id,
  a.platform,
  a.handle,
  a.display_name,
  a.avatar_url,
  a.profile_url,
  a.brand,
  a.is_active,
  l.captured_on                   as as_of,
  l.followers,
  l.total_posts,
  l.total_views,
  l.total_likes,
  (l.followers   - p7.followers)  as followers_delta_7d,
  (l.followers   - p28.followers) as followers_delta_28d,
  (l.total_views - p7.total_views)  as views_delta_7d,
  (l.total_views - p28.total_views) as views_delta_28d,
  case when nullif(p7.followers, 0) is not null
       then round(((l.followers - p7.followers)::numeric / p7.followers) * 100, 2) end as followers_pct_7d,
  case when nullif(p28.followers, 0) is not null
       then round(((l.followers - p28.followers)::numeric / p28.followers) * 100, 2) end as followers_pct_28d
from social.accounts a
left join latest l  on l.account_id  = a.id
left join prev7  p7 on p7.account_id = a.id
left join prev28 p28 on p28.account_id = a.id;

-- ---------------------------------------------------------------
-- Follower / view history for charting
-- ---------------------------------------------------------------
create or replace view public.social_account_series
with (security_invoker = on) as
select
  s.captured_on   as day,
  a.id            as account_id,
  a.platform,
  a.display_name,
  a.handle,
  s.followers,
  s.total_views,
  s.total_posts
from social.account_snapshots s
join social.accounts a on a.id = s.account_id;

-- ---------------------------------------------------------------
-- Daily metric rollup by platform
-- ---------------------------------------------------------------
create or replace view public.social_daily_totals
with (security_invoker = on) as
select
  m.metric_date as day,
  a.platform,
  m.metric,
  sum(m.value)  as value
from social.daily_metrics m
join social.accounts a on a.id = m.account_id
group by 1, 2, 3;

-- ---------------------------------------------------------------
-- Posts with their most recent metrics
-- ---------------------------------------------------------------
create or replace view public.social_top_posts
with (security_invoker = on) as
select
  p.id            as post_id,
  a.platform,
  a.display_name  as account,
  a.handle,
  p.post_type,
  p.title,
  p.caption,
  p.permalink,
  p.thumbnail_url,
  p.published_at,
  p.duration_secs,
  m.views,
  m.likes,
  m.comments,
  m.shares,
  m.saves,
  m.watch_seconds,
  (coalesce(m.likes,0) + coalesce(m.comments,0) + coalesce(m.shares,0) + coalesce(m.saves,0)) as engagements,
  case when coalesce(m.views, 0) > 0
       then round(((coalesce(m.likes,0) + coalesce(m.comments,0) + coalesce(m.shares,0) + coalesce(m.saves,0))::numeric
                   / m.views) * 100, 2) end as engagement_pct
from social.posts p
join social.accounts a on a.id = p.account_id
left join lateral (
  select * from social.post_metrics pm
  where pm.post_id = p.id
  order by pm.captured_on desc
  limit 1
) m on true;

-- ---------------------------------------------------------------
-- Sync health: latest run per platform + per account
-- ---------------------------------------------------------------
create or replace view public.social_sync_health
with (security_invoker = on) as
select distinct on (r.platform, r.account_id)
  r.platform,
  r.account_id,
  a.display_name,
  r.started_at,
  r.finished_at,
  r.status,
  r.rows_written,
  r.message,
  (now() - r.started_at) as age
from social.sync_runs r
left join social.accounts a on a.id = r.account_id
order by r.platform, r.account_id, r.started_at desc;
