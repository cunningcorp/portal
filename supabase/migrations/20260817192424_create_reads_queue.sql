-- Publishing queue for Aubrey North "Reads", per PORTAL-PUBLISH-SPEC.
-- Approved articles wait here; the portal's Publish button invokes the publish-read
-- edge function, which commits the file to cunningcorp/aubreynorth and lets the site's
-- existing GitHub Pages workflow deploy it.
--
-- Access model: the portal shares this project's auth, so signed-in users read the
-- queue directly (SELECT policy below). All writes go through the service role — the
-- portal never inserts or mutates rows, and Claude sessions insert approved drafts via
-- the service role. This settles open decisions 1 and 2 in the spec: verify_jwt, no
-- shared key, direct table read.

create table public.reads_queue (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  slug text not null unique,          -- e.g. 'the-core-read'
  title text not null,
  lane text not null check (lane in ('screen','type','business')),
  description text not null,          -- 140-160 chars, enforced again at publish time
  tags text[] not null default '{}',
  markdown text not null,             -- FULL file content including frontmatter
  target_query text,                  -- SEO note, display-only
  word_count int,                     -- display-only
  status text not null default 'ready'
    check (status in ('ready','publishing','published','failed')),
  published_at timestamptz,
  commit_sha text,
  error text
);

comment on table public.reads_queue is
  'Aubrey North Reads awaiting publication. Publish = the publish-read edge function commits to GitHub; the site deploy does the rest.';

alter table public.reads_queue enable row level security;

-- Signed-in portal users see the queue. No insert/update/delete policies:
-- mutations are service-role only, which is what makes the status guard in
-- publish-read trustworthy.
create policy "authenticated read queue"
  on public.reads_queue for select to authenticated using (true);

create index idx_reads_queue_status on public.reads_queue (status, created_at desc);
