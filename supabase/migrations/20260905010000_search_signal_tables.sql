-- Search Signal Phase 1 (an-search-signal-SPEC §5). Search-performance tables for the
-- Aubrey North site: site/query/page grain from GSC, the per-Read target_query tie-in, GA4
-- daily, and Core Web Vitals. Written ONLY by the sync-search collector (service role); RLS
-- on with authenticated SELECT only — the strict end of the reads_queue posture (no
-- authenticated INSERT/UPDATE/DELETE, no anon), because nothing here is human-edited.

create table if not exists public.search_metrics_daily (
  property     text not null,
  metric_date  date not null,
  dimension    text not null check (dimension in ('overall','query','page')),
  dim_value    text not null default '',
  clicks       integer not null default 0,
  impressions  integer not null default 0,
  ctr          numeric,
  position     numeric,
  raw          jsonb,
  primary key (property, metric_date, dimension, dim_value)
);

create table if not exists public.read_search (
  read_id        uuid references public.reads_queue(id) on delete cascade,
  captured_on    date not null,
  target_query   text,
  q_position numeric, q_clicks integer, q_impressions integer, q_ctr numeric,
  page_clicks integer, page_impressions integer, page_position numeric,
  raw jsonb,
  primary key (read_id, captured_on)
);

create table if not exists public.page_vitals (
  url text not null, captured_on date not null,
  lcp_ms integer, inp_ms integer, cls numeric, perf_score integer, raw jsonb,
  primary key (url, captured_on)
);

create table if not exists public.ga_daily (
  metric_date date not null, metric text not null, value numeric not null default 0,
  primary key (metric_date, metric)
);

alter table public.search_metrics_daily enable row level security;
alter table public.read_search          enable row level security;
alter table public.page_vitals          enable row level security;
alter table public.ga_daily             enable row level security;

create policy "authenticated read search_metrics_daily" on public.search_metrics_daily for select to authenticated using (true);
create policy "authenticated read read_search"          on public.read_search          for select to authenticated using (true);
create policy "authenticated read page_vitals"          on public.page_vitals          for select to authenticated using (true);
create policy "authenticated read ga_daily"             on public.ga_daily             for select to authenticated using (true);
