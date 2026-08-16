-- Design handoff signal-2a, §6 request 3: persist the YouTube access mode as
-- data and surface it per account, so the UI keys on a value instead of
-- string-matching a sync_runs.message sentence.
--
-- sync-youtube already computes the mode (e.g. "public:key+analytics" vs
-- "public:key"); a companion change to that function writes it here. A standalone
-- "analytics" component means the channel has working daily Analytics.
alter table social.accounts add column if not exists access_mode text;

comment on column social.accounts.access_mode is
  'How this account is collected, e.g. public:key, public:key+analytics, public:oauth+analytics, none. Written by the sync collectors; a standalone "analytics" component means daily analytics are available.';

-- Surface it through the overview view (access_mode appended last; CREATE OR
-- REPLACE can only add columns at the end). Definition is otherwise unchanged;
-- security_invoker stays on.
create or replace view public.social_accounts_overview with (security_invoker = on) as
with latest as (
  select distinct on (account_snapshots.account_id) account_snapshots.account_id,
    account_snapshots.captured_on, account_snapshots.followers,
    account_snapshots.total_posts, account_snapshots.total_views, account_snapshots.total_likes
  from social.account_snapshots
  order by account_snapshots.account_id, account_snapshots.captured_on desc
), prev7 as (
  select distinct on (s.account_id) s.account_id, s.followers, s.total_views
  from social.account_snapshots s
  join latest l_1 on l_1.account_id = s.account_id
  where s.captured_on <= (l_1.captured_on - 7)
  order by s.account_id, s.captured_on desc
), prev28 as (
  select distinct on (s.account_id) s.account_id, s.followers, s.total_views
  from social.account_snapshots s
  join latest l_1 on l_1.account_id = s.account_id
  where s.captured_on <= (l_1.captured_on - 28)
  order by s.account_id, s.captured_on desc
)
select a.id as account_id, a.platform, a.handle, a.display_name, a.avatar_url,
  a.profile_url, a.brand, a.is_active, l.captured_on as as_of, l.followers,
  l.total_posts, l.total_views, l.total_likes,
  l.followers - p7.followers as followers_delta_7d,
  l.followers - p28.followers as followers_delta_28d,
  l.total_views - p7.total_views as views_delta_7d,
  l.total_views - p28.total_views as views_delta_28d,
  case when nullif(p7.followers, 0) is not null
       then round((l.followers - p7.followers)::numeric / p7.followers::numeric * 100::numeric, 2)
       else null::numeric end as followers_pct_7d,
  case when nullif(p28.followers, 0) is not null
       then round((l.followers - p28.followers)::numeric / p28.followers::numeric * 100::numeric, 2)
       else null::numeric end as followers_pct_28d,
  a.access_mode
from social.accounts a
left join latest l on l.account_id = a.id
left join prev7 p7 on p7.account_id = a.id
left join prev28 p28 on p28.account_id = a.id;
