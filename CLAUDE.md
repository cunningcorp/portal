# Signal — handover brief

You are picking up a working-but-unproven internal analytics portal. It was built in one
pass. The architecture is sound and the database is verified; the parts that talk to
Instagram, YouTube and TikTok have **never once run against a real API**. Your job is to
make it true, then make it solid. A visual design pass is happening separately and later —
do not spend your effort there.

Read this whole file before writing code.

---

## What this is

One dashboard over Cunning Corp's YouTube, Instagram, Facebook and TikTok accounts.
Static page on GitHub Pages at `portal.cunningcorp.com`, backed by the **`aubreynorth`
Supabase project (`qeafetctmtnqonhwhhlw`, eu-central-1)**.

Nothing scrapes. Every figure comes from the platform's own API on our own OAuth
credentials, into our own Postgres.

```
index.html ──auth──▶ Supabase Auth (magic link)
           ──read──▶ public.social_* views  (RLS: authenticated only)
           ──POST──▶ /functions/v1/sync-all
           ──POST──▶ /functions/v1/oauth-start

pg_cron ───daily──▶ sync-all ──▶ sync-youtube │ sync-meta │ sync-tiktok
                                       └──▶ platform APIs ──▶ social.* tables
```

Everything deployed is mirrored in `supabase/` — four migrations and seven edge functions,
extracted verbatim from the live project. Treat those files as the source of truth and
redeploy from them; do not hand-edit the remote and let the two drift.

---

## The one thing that matters most

**No collector has ever executed against a live platform.** Every API call in
`sync-youtube`, `sync-meta` and `sync-tiktok` was written from documentation, not from an
observed response. Field names, nesting, pagination shape, error envelopes — all of it is
educated guesswork until proven otherwise.

What *is* verified: the schema, the five read views (smoke-tested with synthetic data —
deltas, percentages and engagement rates all compute correctly), the RLS posture, and the
frontend's ability to parse and render what those views return.

So the first task, before any refactor, is:

1. Get one real credential per platform in place (see `SETUP.md`).
2. Call each API **once, by hand**, and look at the actual payload.
3. Correct the parsers against what you saw, not what the docs claim.
4. Only then start improving structure.

Refactoring code whose core assumption is unverified is how you end up with beautifully
organised wrong answers.

---

## Locked — do not change without asking

**Project location.** Everything stays in the `aubreynorth` Supabase project. This was a
deliberate decision, taken knowing the portal is group-level infrastructure sitting in a
division's project. Don't migrate it.

**Schema shape.** The `social` schema and the five `public.social_*` views are the
contract between collectors and frontend. Extend them freely; don't rename or restructure
what's there.

**Security posture.** These are not stylistic choices:
- `social.credentials` and `social.oauth_states` have RLS enabled and *zero* policies.
  That is intentional — it makes them service-role-only. Do not add a policy to "fix" the
  linter INFO warnings.
- All views are `security_invoker = on` so RLS on the underlying tables still applies.
- `oauth-callback` has `verify_jwt = false` because OAuth providers redirect the browser
  there with no Authorization header. It is gated instead on a single-use, 15-minute
  `state` token. Do not turn JWT verification on; do not weaken the state check.
- The service role key must never appear in this repo or in client code.

**Brand.** Palette and type are locked by the Cunning Corp Brand Handbook and documented
in `README.md`. Two deliberate departures are recorded there with reasoning — platform
colours as data encoding, and semantic states drawn from division accents. Leave both
alone; the design pass can revisit them.

---

## Known rough edges, roughly in priority order

**Correctness and durability**

1. Meta's metric surface is actively shrinking — `impressions`, `plays` and `profile_views`
   were retired across all API versions in April 2025. `sync-meta` already tolerates
   individual metric failures rather than failing the whole run, but the metric list needs
   checking against what actually returns data.
2. `post_metrics` and `daily_metrics` grow one row per post per day, forever. No retention
   policy exists. At a few hundred posts this is nothing; plan for it before it isn't.
3. No rate-limit handling or backoff anywhere. YouTube's 10,000 daily units is generous,
   Meta's is not, and TikTok's is undocumented in practice.
4. Edge functions have a wall-clock limit. `sync-all` fans out in parallel, but each
   collector loops accounts serially and calls per-post insight endpoints one at a time.
   With several accounts this will eventually time out.
5. `deriveDaily` in `sync-tiktok` differences consecutive snapshots. If a day's sync is
   missed, the next day's delta silently absorbs two days of movement. It should either
   divide across the gap or record nothing.

**Security hygiene**

6. `sync-meta` and `probe` pass the Meta access token as an `&access_token=` query
   parameter. This is the convention Meta's own docs use and the token never reaches a
   client — but secrets in URLs are far more likely to end up in proxy and platform logs
   than secrets in headers. The Graph API accepts `Authorization: Bearer <token>`. Worth
   converting both, in one pass so they stay consistent. Nothing is leaking today; this is
   reducing the blast radius of a log you don't control.

**Structure**

7. `shared.ts` is byte-identical across the three collectors. Deliberate for now — they
   import it relatively and collapsing it naively breaks redeploys — but an import map or
   a published module would be cleaner.
8. No tests of any kind.
9. No CI. Deploys are manual.
10. No cron job exists yet. `pg_cron` and `pg_net` are enabled and the SQL is written out in
   `SETUP.md`, but nothing is scheduled. If you create one, capture it in a migration so
   it's reproducible.

**Frontend**

11. Platform selection on connect uses `window.prompt()`. It works; it's ugly.
12. Charts render empty with no explanation when there's no data for a range. An empty
    state per chart would save confusion during the weeks before history builds up.
13. The posts table caps at 150 rows with no pagination.
14. Accessibility is thin: sortable table headers aren't keyboard reachable, there's no
    `aria-sort`, no focus-visible styling, and toasts aren't announced.
15. One inline `onerror` handler on avatar images.

---

## Ground rules

- **Deploy from `supabase/`, not from memory.** `supabase functions deploy <slug>` and
  `supabase db push`. `config.toml` records each function's `verify_jwt` — respect it.
- **Don't add a build step to the frontend.** It is deliberately one file served from the
  repo root. If it grows past one page, port it to Astro the way `aubreynorth` is built —
  but that's a decision to raise, not to take.
- **Write for the reader after you.** The existing code comments explain *why* where the
  reasoning isn't obvious from the code — particularly around API quirks and the security
  choices above. Keep that up.
- **Flag, don't silently fix, anything in the Locked section.**

## Reference

- `README.md` — deploy steps, DNS, brand tokens, security posture
- `SETUP.md` — schema reference and the full API credential path for all three platforms,
  including approval requirements and known blockers
- `supabase/migrations/` — the four migrations, in order
- `supabase/functions/` — all seven functions as deployed
- `CREDENTIALS.md` — the three developer consoles and the connect → probe → fix loop
- `probe` — read-only diagnostic; returns raw API payloads, writes nothing. Use it before
  trusting any parser.
