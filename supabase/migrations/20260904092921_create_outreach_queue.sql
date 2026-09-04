-- Outreach Queue for Aubrey North prospecting -- both lanes (business via Apollo,
-- creator via YouTube) in ONE table, per Prospecting Engine/portal/INTEGRATION-ANALYSIS.md
-- v1.1 and DECISIONS.md (4 Sep 2026). Mirrors reads_queue's conventions and access model:
-- uuid pk, a status check-constraint lifecycle, jsonb for structured blocks, RLS on,
-- the portal REVIEWS through an authenticated, column-scoped UPDATE, and only the
-- service role (insert-prospect / the enrol write-back) can create rows or record a send.
--
-- The one rule the shape enforces: the queue proposes, Demetri disposes, nothing sends
-- without an Approve -- and the client can never say "sent".
--
-- DELIBERATE DEVIATION FROM THE SPEC (DECISIONS D2): `email` and `email_status` ARE in the
-- client's UPDATE grant. In the creator lane most business emails sit behind YouTube's
-- CAPTCHA-gated "View email address" button, which no task or function can press, so
-- Demetri is the only possible source and types them in on the review card
-- (email_status = 'manual'). Column grants cannot be conditional on lane, so the grant is
-- table-wide for those two columns. The SEND RECORD -- apollo_contact_id, sent_at,
-- reply_at, error -- stays physically un-writable by the client, and the WITH CHECK below
-- pins client-set status to the four review states. A typed email is an input to sending,
-- not a record of it.

create table public.outreach_queue (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- Lane + source. source_ref = Apollo person id | YouTube channel id | null for manual.
  lane           text not null check (lane in ('business','creator')),
  source         text not null check (source in ('apollo','youtube','manual')),
  source_ref     text,

  -- Display spine, lane-neutral.
  --   business: title = job title, company = company, website = company site
  --   creator : title = null,      company = channel name, website = linked site or channel URL
  --   sector  : business = property | hospitality | media ... ; creator = the niche
  full_name      text not null,
  first_name     text not null,
  title          text,
  company        text not null,
  website        text not null,
  sector         text,

  -- Source-specific facts. youtube: { channel_url, handle, subscribers, videos, total_views,
  -- country, last_upload, active, pb_signal, fit_score, discovered_query }
  -- apollo: { headcount, industry, linkedin_url, city }
  prospect       jsonb not null default '{}'::jsonb,

  -- Contact. null until revealed (business) or found/typed (creator).
  email          text,
  email_status   text not null default 'unrevealed'
                 check (email_status in ('unrevealed','public','manual','verified','catch_all','unavailable')),

  -- Research.
  -- audit  = the short, card-facing summary, shape per lane:
  --   business: { leads_with, one_true_thing, evidence, stated_standard, move }
  --   creator : { five_second_read, real_story, real_story_quote, gap, one_shift }
  -- dossier = the full Narrative Due Diligence (business lane; creator rows leave it empty):
  --   { why_approach, why_now, why_them, hook,
  --     surface_map:{ homepage, about, linkedin_co, founder_words, press, agree, fracture },
  --     company:[{claim,source,date,confidence}], owner:[...], signals:[...], social:[...],
  --     red_flags:[...], thin_reason }
  -- dd_complete defaults FALSE on purpose: a row that says nothing must not claim completion.
  -- false = footprint too thin to finish the five reads; dossier.thin_reason says why; a
  -- human decides on the card.
  audit_case     text check (audit_case in ('buried','mislabelled','sharp')),
  audit          jsonb not null default '{}'::jsonb,
  dossier        jsonb not null default '{}'::jsonb,
  confidence     text check (confidence in ('high','medium','low')),
  dd_complete    boolean not null default false,

  -- Draft. hook = the first step the email offers; it picks the Apollo sequence at enrol.
  hook           text not null default 'coffee_chat' check (hook in ('coffee_chat','teardown')),
  subject        text not null,
  body           text not null,
  variant        text not null default 'direct' check (variant in ('direct','story_first')),
  -- { passed, spine_ok, hard_block:[], soft_warn:[], clarity_flags:[], notes:[] }
  voice_check    jsonb not null default '{}'::jsonb,

  -- Lifecycle. in_review -> approved -> enrolling -> enrolled -> replied | bounced | declined.
  -- Also rejected, snoozed (with snooze_until), failed (with error).
  status         text not null default 'in_review'
                 check (status in ('in_review','approved','rejected','snoozed',
                                   'enrolling','enrolled','replied','bounced','declined','failed')),
  snooze_until   timestamptz,
  reject_reason  text,

  -- Send record. Service role only (outside the client grant below).
  apollo_contact_id text,
  sent_at        timestamptz,
  reply_at       timestamptz,
  error          text,

  notes          text
);

comment on table public.outreach_queue is
  'Aubrey North outreach prospects awaiting review. Both lanes (business/creator). The daily task inserts via insert-prospect; the portal approves; Claude in Chrome enrols in Apollo and the service role records the send.';

create index outreach_queue_status_idx      on public.outreach_queue (status, created_at desc);
create index outreach_queue_lane_status_idx on public.outreach_queue (lane, status);
-- Dedupe on the source identity. Partial so manual rows (no ref) never collide.
create unique index outreach_queue_source_idx on public.outreach_queue (source, source_ref)
  where source_ref is not null;

alter table public.outreach_queue enable row level security;

-- Read: the signed-in portal session (same auth the Reads Queue uses). No anon policy.
create policy outreach_queue_authenticated_select
  on public.outreach_queue for select to authenticated using (true);

-- Write: Supabase grants authenticated/anon a table-wide UPDATE by default (gated by RLS),
-- which would override a column-scoped grant (the reads_queue lockdown lesson). Revoke it
-- and re-grant ONLY the reviewer-editable columns, so the send record is physically
-- un-writable by the client on top of the RLS status guard.
revoke update on public.outreach_queue from authenticated;
revoke update on public.outreach_queue from anon;
grant update (
  subject, body, variant, status, reject_reason, snooze_until, notes,
  email, email_status,            -- DECISIONS D2, see header
  updated_at
) on public.outreach_queue to authenticated;

-- WITH CHECK pins client-set status to the review states. enrolling/enrolled/replied/
-- bounced/declined/failed are set by the enrol write-back (service role) -- the client
-- cannot forge "sent". Consequence, accepted for now: once a row has left the review
-- states the client cannot edit it at all (not even notes); the sent copy is a record.
create policy outreach_queue_authenticated_update
  on public.outreach_queue for update to authenticated
  using (true)
  with check (status in ('in_review','approved','rejected','snoozed'));

-- No INSERT or DELETE policy for authenticated: insert-prospect (service role) inserts.

-- Keep updated_at honest on every edit, identical to reads_queue.
create or replace function public.outreach_queue_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Pin the function's search_path (silences the function_search_path_mutable linter and
-- removes a search-path-injection surface). now() resolves from pg_catalog regardless.
alter function public.outreach_queue_touch_updated_at() set search_path = '';

drop trigger if exists trg_outreach_queue_touch on public.outreach_queue;
create trigger trg_outreach_queue_touch
  before update on public.outreach_queue
  for each row execute function public.outreach_queue_touch_updated_at();
