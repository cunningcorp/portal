-- Reads Editor v2 (PORTAL-EDITOR-SPEC Part 2): turn the publish queue into an
-- editable queue. Additive and non-breaking: existing rows and the publish path
-- are unaffected. body_markdown holds the editable body; the frontmatter lives in
-- the existing title/description/tags/target_query columns and is recombined with
-- body_markdown into the full `markdown` payload on save.

alter table public.reads_queue
  add column if not exists body_markdown   text,
  add column if not exists suggestions     jsonb   not null default '[]'::jsonb,
  add column if not exists sources         jsonb   not null default '[]'::jsonb,
  add column if not exists sources_checked boolean not null default false,
  add column if not exists updated_at      timestamptz not null default now(),
  add column if not exists notes           text;

-- Expand the status lifecycle: draft -> in_review -> ready -> publishing ->
-- published | failed. (Was: ready | publishing | published | failed.)
alter table public.reads_queue drop constraint if exists reads_queue_status_check;
alter table public.reads_queue add constraint reads_queue_status_check
  check (status in ('draft','in_review','ready','publishing','published','failed'));

-- Keep updated_at honest on every edit.
create or replace function public.reads_queue_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_reads_queue_touch on public.reads_queue;
create trigger trg_reads_queue_touch
  before update on public.reads_queue
  for each row execute function public.reads_queue_touch_updated_at();
