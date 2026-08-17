# Spec — "Reads" publishing module for portal.cunningcorp.com

_Prepared 17 Aug 2026 for the portal design/build chat. Owner: Demetri._

## What this is

A publishing queue inside the existing Cunning Corp portal. Approved Aubrey North
articles ("Reads") wait in a queue; Demetri clicks **Publish**; the article goes live on
aubreynorth.com about two minutes later. No git, no terminal, no code on Demetri's side.

This module is UI + one API call. All heavy lifting happens in a Supabase edge function
that commits the article to GitHub, which triggers the site's existing auto-deploy.

## How aubreynorth.com publishes (context the builder needs)

- Static Astro site in GitHub repo **`cunningcorp/aubreynorth`**, deployed to GitHub
  Pages by `.github/workflows/deploy.yml` **on every push to `main`** (~2 min).
- An article = one markdown file at **`src/content/reads/<slug>.md`** with YAML
  frontmatter: `title`, `description` (140–160 chars), `lane`
  (`screen|type|business`), `pubDate` (YYYY-MM-DD), `draft` (bool), `tags` (string[]).
- `draft: true` files are excluded from the build and sitemap automatically.
- **Nothing in the site repo needs to change for this project.** Committing a valid
  file to `main` IS publishing.

## Content pipeline (who does what)

1. Claude drafts a Read in a Cowork session; Demetri reviews/edits **in chat** — that
   remains the copy gate (copylock rule; the portal does not edit copy).
2. On approval, Claude inserts the final markdown into the queue table (below) with
   status `ready`.
3. Portal lists `ready` items. Demetri clicks Publish when he chooses.
4. Edge function commits the file to GitHub with `draft: false` and `pubDate` set to
   the publish date; deploy runs automatically; row becomes `published`.

## Data model (Supabase)

Project: **aubreynorth** (`qeafetctmtnqonhwhhlw`) — colocated with the site's existing
backend (contact form). The portal reads it cross-project via the edge function only.

```sql
create table public.reads_queue (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  slug text not null unique,          -- e.g. 'the-core-read'
  title text not null,
  lane text not null check (lane in ('screen','type','business')),
  description text not null,          -- 140–160 chars
  tags text[] not null default '{}',
  markdown text not null,             -- FULL file content incl. frontmatter
  target_query text,                  -- SEO note, display-only
  word_count int,                     -- display-only
  status text not null default 'ready'
    check (status in ('ready','publishing','published','failed')),
  published_at timestamptz,
  commit_sha text,
  error text
);
alter table public.reads_queue enable row level security;
-- NO anon policies. Access is via service role (edge function) and, if the portal
-- shares this Supabase project's auth, an authenticated SELECT policy. Otherwise the
-- portal reads the queue through a second edge function (`list-queue`) guarded the
-- same way as publish-read.
```

## Edge function: `publish-read`

Deployed in the same Supabase project. Secrets (function env, never client-side):

- `GITHUB_TOKEN` — **fine-grained PAT**, access to `cunningcorp/aubreynorth` only,
  permission: Contents read/write. Demetri creates at GitHub → Settings → Developer
  settings → Fine-grained tokens.
- `PORTAL_SHARED_KEY` — random string; the portal sends it as `x-portal-key`. (If the
  portal uses this same Supabase project's auth, use `verify_jwt` instead and drop the
  shared key.)

Behaviour:

1. Reject unless `x-portal-key` matches (or JWT valid). Input: `{ id }`.
2. Load row; must be status `ready` (idempotency guard). Set `publishing`.
3. Validate: slug `[a-z0-9-]+`; frontmatter parses; description 140–160 chars; lane
   valid. On failure → status `failed`, store `error`, return 422.
4. Rewrite frontmatter: force `draft: false`, set `pubDate` to today (Europe/London).
5. GitHub Contents API `PUT /repos/cunningcorp/aubreynorth/contents/src/content/reads/{slug}.md`
   on `main`, commit message `Publish Read: {title}`. If the file already exists,
   include its current `sha` (fetch first) so re-publishing updates it.
6. On success: status `published`, `published_at`, `commit_sha`; return
   `{ url: "https://aubreynorth.com/reads/{slug}/" }`.
7. On GitHub error: status `failed` + `error`; the UI surfaces it and offers retry
   (retry = same call; step 2's guard must allow `failed` → `publishing`).

CORS: allow origin `https://portal.cunningcorp.com` only.

## Portal UI

A "Reads" section with two views. Match the portal's existing design system; content
below is the requirement, not the styling.

**Queue (default).** Card or row per `ready`/`failed` item: title, lane badge, target
query, word count, date queued, and an expandable **rendered markdown preview**
(read-only — no editing in the portal). Primary action **Publish** with a confirm step
("Publishes to aubreynorth.com within ~2 minutes"). While `publishing`: disable button,
show progress. On success: swap to the live URL. On `failed`: show `error`, offer Retry.

**Published.** Reverse-chronological history: title, published date, live link,
commit sha (small/secondary).

Empty queue state: one quiet line, e.g. "Nothing waiting." (Aubrey North adjacent —
no exclamation marks.)

## Explicitly out of scope (v1)

Editing copy in the portal · scheduling · unpublish/rollback (removing a live Read
stays a git operation) · analytics · multi-site support. Design for them, build none.

## Acceptance criteria

- [ ] Publish click → article live at `https://aubreynorth.com/reads/<slug>/` within
      ~3 min, `draft: false`, `pubDate` = publish date, sitemap includes it.
- [ ] The GitHub token exists **only** as an edge-function secret. Nothing sensitive in
      portal client code; function rejects calls without the key/JWT.
- [ ] Double-click / repeat calls cannot double-publish (status guard).
- [ ] A failed publish shows the reason and can be retried without dev help.
- [ ] Queue table has RLS on, zero anon access.

## Seed data

First queue item: **The Core Read** (`the-core-read`, lane `screen`, target query
"what makes a character compelling") — approved copy already exists in the site repo at
`src/content/reads/the-core-read.md` (currently parked as `draft: true`). Insert its
full markdown as the seed row, then delete the parked file from the repo in the same
release (the queue becomes the single source of truth for unpublished Reads).

## Open decisions for the design chat

1. Auth wiring: does portal.cunningcorp.com already sit on a Supabase project/auth?
   (Decides shared-key vs `verify_jwt`.)
2. Where the queue list is read from: direct table read (same-project auth) or a
   `list-queue` edge function (cross-project).
3. Whether Publish also pings Demetri (email/Slack) on success/failure.
