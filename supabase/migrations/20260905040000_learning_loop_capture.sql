-- Learning loop — capture layer (LEARNING-LOOP-SPEC Part 1 + the read_edits/rule_proposals
-- tables). The engine improves by improving VOICE-RULES.md: it captures Demetri's edits at
-- publish, a weekly pass clusters recurring changes, and proposes rule updates Demetri approves.
-- This migration is the capture half — always-on, diff-only, zero extra effort at publish.

-- 1) Freeze the AI draft. insert-draft writes original_markdown = markdown ONCE at insert.
--    It is deliberately LEFT OUT of the authenticated UPDATE column grant (see migrations
--    20260821142426_reads_queue_editor_write_policy / …142622_…column_update_lockdown), so
--    the editor client physically cannot mutate it — the freeze is enforced by Postgres, not
--    by convention. The editor edits markdown / body_markdown as normal.
alter table public.reads_queue
  add column if not exists original_markdown text;
comment on column public.reads_queue.original_markdown is
  'The AI draft, frozen at insert by insert-draft; excluded from the authenticated UPDATE grant so the editor cannot overwrite it. Baseline for the learning-loop diff (LEARNING-LOOP-SPEC Part 1).';

-- 2) The edit record. publish-read writes exactly one row per successful publish (original ->
--    final, with a computed diff). An unedited publish still lands with an empty diff — that
--    empty diff is itself signal (the engine got that one right).
create table if not exists public.read_edits (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  slug              text not null,
  queue_id          uuid references public.reads_queue(id),
  lane              text not null,
  commit_sha        text,                     -- the publish commit, ties the record to git
  original_markdown text not null,            -- the AI draft
  final_markdown    text not null,            -- what Demetri published
  diff              jsonb not null,           -- structured hunks + the Part 4 edit-weight metric
  suggestions       jsonb not null default '[]'  -- suggestions offered + outcome, if available (bonus signal)
);
create index if not exists read_edits_created_at_idx on public.read_edits (created_at desc);
create index if not exists read_edits_lane_idx on public.read_edits (lane);

-- 3) The proposals a learning pass raises. Written by the weekly pass (service role); reviewed
--    by Demetri. v1's review surface is a git PR against VOICE-RULES.md (BUILD-KICKOFF decision
--    6); this table is the queryable record and the seed for a later portal "Learning" view.
create table if not exists public.rule_proposals (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  summary            text not null,           -- the pattern in a line
  proposed_change    text not null,           -- the exact VOICE-RULES.md addition/edit
  examples           jsonb not null,          -- real before->after pairs from read_edits, with slugs
  occurrences        int not null,            -- how many distinct Reads showed it
  status             text not null default 'proposed'
                       check (status in ('proposed','approved','rejected','applied')),
  applied_commit_sha text
);
create index if not exists rule_proposals_status_idx on public.rule_proposals (status, created_at desc);

-- RLS: same posture as the search tables — authenticated SELECT only (review + the trend
-- metric), service-role writes (the pass / publish-read). No anon, no authenticated writes:
-- nothing here is human-edited from the client, and the write path is the PR, not the portal.
alter table public.read_edits     enable row level security;
alter table public.rule_proposals enable row level security;

create policy "read_edits: authenticated read"     on public.read_edits
  for select to authenticated using (true);
create policy "rule_proposals: authenticated read" on public.rule_proposals
  for select to authenticated using (true);
