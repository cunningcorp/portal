-- Social portal: unified analytics across YouTube, Instagram, Facebook, TikTok

create schema if not exists social;

-- ---------------------------------------------------------------
-- Accounts: one row per connected channel/profile
-- ---------------------------------------------------------------
create table if not exists social.accounts (
  id            uuid primary key default gen_random_uuid(),
  platform      text not null check (platform in ('youtube','instagram','facebook','tiktok')),
  external_id   text not null,
  handle        text,
  display_name  text,
  avatar_url    text,
  profile_url   text,
  brand         text,
  is_active     boolean not null default true,
  connected_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (platform, external_id)
);

comment on table social.accounts is 'One row per connected social account / channel.';
comment on column social.accounts.brand is 'Optional grouping label, e.g. Cunning Ideas, Paw & Pocket.';

-- ---------------------------------------------------------------
-- Credentials: service-role only. No RLS policies = no client access.
-- ---------------------------------------------------------------
create table if not exists social.credentials (
  account_id    uuid primary key references social.accounts(id) on delete cascade,
  platform      text not null,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  scopes        text[],
  extra         jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);

comment on table social.credentials is 'OAuth tokens. Readable only by service_role - never exposed to the browser.';
comment on column social.credentials.extra is 'Platform specifics: page_id, ig_user_id, business_account_id etc.';

-- ---------------------------------------------------------------
-- Account snapshots: point-in-time account totals, one row per day
-- ---------------------------------------------------------------
create table if not exists social.account_snapshots (
  account_id   uuid not null references social.accounts(id) on delete cascade,
  captured_on  date not null default current_date,
  followers    bigint,
  following    bigint,
  total_posts  bigint,
  total_views  bigint,
  total_likes  bigint,
  raw          jsonb,
  captured_at  timestamptz not null default now(),
  primary key (account_id, captured_on)
);

comment on table social.account_snapshots is 'Daily cumulative totals per account. Followers = subscribers on YouTube, fans on Facebook.';

-- ---------------------------------------------------------------
-- Daily metrics: long-format timeseries from analytics endpoints
-- ---------------------------------------------------------------
create table if not exists social.daily_metrics (
  account_id   uuid not null references social.accounts(id) on delete cascade,
  metric_date  date not null,
  metric       text not null,
  value        numeric not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (account_id, metric_date, metric)
);

comment on table social.daily_metrics is 'Per-day metrics: views, watch_time_minutes, reach, impressions, profile_views, followers_gained, engagements.';

-- ---------------------------------------------------------------
-- Posts and their metrics
-- ---------------------------------------------------------------
create table if not exists social.posts (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references social.accounts(id) on delete cascade,
  external_id    text not null,
  published_at   timestamptz,
  post_type      text,
  title          text,
  caption        text,
  permalink      text,
  thumbnail_url  text,
  duration_secs  integer,
  created_at     timestamptz not null default now(),
  unique (account_id, external_id)
);

create table if not exists social.post_metrics (
  post_id       uuid not null references social.posts(id) on delete cascade,
  captured_on   date not null default current_date,
  views         bigint,
  likes         bigint,
  comments      bigint,
  shares        bigint,
  saves         bigint,
  watch_seconds bigint,
  raw           jsonb,
  captured_at   timestamptz not null default now(),
  primary key (post_id, captured_on)
);

-- ---------------------------------------------------------------
-- Sync run log
-- ---------------------------------------------------------------
create table if not exists social.sync_runs (
  id           bigint generated always as identity primary key,
  platform     text not null,
  account_id   uuid references social.accounts(id) on delete set null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','ok','error','skipped')),
  rows_written integer not null default 0,
  message      text
);

-- ---------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------
create index if not exists idx_accounts_platform      on social.accounts (platform) where is_active;
create index if not exists idx_snapshots_date         on social.account_snapshots (captured_on desc);
create index if not exists idx_daily_metrics_date     on social.daily_metrics (metric_date desc);
create index if not exists idx_daily_metrics_metric   on social.daily_metrics (metric, metric_date desc);
create index if not exists idx_posts_account_pub      on social.posts (account_id, published_at desc);
create index if not exists idx_posts_published        on social.posts (published_at desc);
create index if not exists idx_post_metrics_captured  on social.post_metrics (captured_on desc);
create index if not exists idx_sync_runs_started      on social.sync_runs (started_at desc);
create index if not exists idx_sync_runs_account      on social.sync_runs (account_id);

-- ---------------------------------------------------------------
-- Row Level Security
-- Reads: any signed-in user. Writes: service_role only (bypasses RLS).
-- ---------------------------------------------------------------
alter table social.accounts          enable row level security;
alter table social.credentials       enable row level security;
alter table social.account_snapshots enable row level security;
alter table social.daily_metrics     enable row level security;
alter table social.posts             enable row level security;
alter table social.post_metrics      enable row level security;
alter table social.sync_runs         enable row level security;

create policy "authenticated read accounts"
  on social.accounts for select to authenticated using (true);
create policy "authenticated read snapshots"
  on social.account_snapshots for select to authenticated using (true);
create policy "authenticated read daily metrics"
  on social.daily_metrics for select to authenticated using (true);
create policy "authenticated read posts"
  on social.posts for select to authenticated using (true);
create policy "authenticated read post metrics"
  on social.post_metrics for select to authenticated using (true);
create policy "authenticated read sync runs"
  on social.sync_runs for select to authenticated using (true);

-- social.credentials intentionally has RLS on and zero policies.
