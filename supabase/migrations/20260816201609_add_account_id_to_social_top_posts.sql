-- Design handoff signal-2a, §6 request 2: add account_id to social_top_posts.
--
-- The view exposed `account` (= a.display_name) and `handle` but no id, so posts
-- could only be tied to an account by name — and the same brand name legitimately
-- runs on several platforms. Adding a.id lets the frontend filter posts by
-- account_id and retire the platform|display_name compound-key workaround.
-- Definition is otherwise identical to the original (security_invoker stays on).
-- account_id is appended last (after engagement_pct): CREATE OR REPLACE VIEW can
-- only add columns at the end, and the frontend reads select("*").
create or replace view public.social_top_posts with (security_invoker = on) as
select
  p.id as post_id,
  a.platform,
  a.display_name as account,
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
  coalesce(m.likes, 0::bigint) + coalesce(m.comments, 0::bigint) + coalesce(m.shares, 0::bigint) + coalesce(m.saves, 0::bigint) as engagements,
  case
    when coalesce(m.views, 0::bigint) > 0 then round((coalesce(m.likes, 0::bigint) + coalesce(m.comments, 0::bigint) + coalesce(m.shares, 0::bigint) + coalesce(m.saves, 0::bigint))::numeric / m.views::numeric * 100::numeric, 2)
    else null::numeric
  end as engagement_pct,
  a.id as account_id
from social.posts p
join social.accounts a on a.id = p.account_id
left join lateral (
  select pm.post_id, pm.captured_on, pm.views, pm.likes, pm.comments,
         pm.shares, pm.saves, pm.watch_seconds, pm.raw, pm.captured_at
  from social.post_metrics pm
  where pm.post_id = p.id
  order by pm.captured_on desc
  limit 1
) m on true;
