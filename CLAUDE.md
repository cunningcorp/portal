# Signal — handover brief

You are picking up a partly proven internal analytics portal. YouTube and Instagram both
run end to end against live APIs and have real data in the database. Facebook and TikTok
have never executed against a real API at all. Your job is to finish proving it, then make
it solid. A visual design pass is happening separately and later —
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

pg_cron ───daily──▶ sync-all ──▶ sync-youtube │ sync-instagram │ sync-meta │ sync-tiktok
                                       └──▶ platform APIs ──▶ social.* tables
```

Everything deployed is mirrored in `supabase/` — seven migrations and eight edge functions,
extracted verbatim from the live project. Treat those files as the source of truth and
redeploy from them; do not hand-edit the remote and let the two drift.

---

## What is proven and what is not

| Collector | Status |
|---|---|
| `sync-youtube` | **Proven.** Ran against the live channel. All eight analytics metrics mapped without a rename; 42 posts, 33 days of daily metrics and a snapshot landed correctly. |
| `sync-instagram` | **Proven.** Business Login for Instagram, no Facebook Page. Profile, 29 days of daily reach, eight 28-day rolling totals and 38 posts with per-post metrics all landed. `follows_and_unfollows` returns nothing below 100 followers — Meta's threshold, not a fault. |
| `sync-meta` | Never executed. No Facebook Page exists to test against. Correctly skips Instagram Login accounts, so it sits quiet rather than erroring. |
| `sync-tiktok` | Never executed. |

For anything unproven, the order is: connect the account, run `probe`, read the actual
payload, correct the parser, *then* refactor. Reorganising code whose core assumption is
unverified just produces beautifully organised wrong answers.

`probe` is a read-only diagnostic that calls every endpoint a collector depends on and
returns the raw response with tokens masked and arrays trimmed. Each result carries a
`note` describing what the collector assumes about that response, so the comparison is
right there. It writes nothing. Use it before trusting anything.

Two findings from the YouTube run that generalise:

- **Test as the role that will actually run.** The views were verified as `postgres`,
  which bypasses grants and RLS entirely, so a total absence of privileges went unnoticed
  until a real signed-in user hit a wall of 403s. `set local role authenticated;` before
  checking anything user-facing.
- **Documentation lags the API.** Instagram's account-level `follower_count` metric no
  longer exists; `follows_and_unfollows` with a `follow_type` breakdown replaced it. That
  was caught by reading current docs rather than trusting the code. Assume more of this.

---

## Deployment prerequisites that are easy to miss

Both of these were live bugs, not theory. A rebuild into a fresh project hits them again.

**1. The `social` schema must be exposed to PostgREST.** The collectors reach `social.*`
through supabase-js with `db.schema = 'social'`. PostgREST only serves schemas in its
`db-schemas` list, which defaults to `public, graphql_public`. Without `social` there,
every function fails with `Invalid schema: social` regardless of grants. Migration
`expose_social_schema_to_postgrest` sets it at the database level, but the dashboard
(Settings → API → Exposed schemas) writes the same setting and will overwrite it if saved
without `social` present. Keep the two in agreement.

**2. Grants are not implied by RLS policies.** A policy says who may see which rows; a
grant says whether the role may touch the table at all. Nothing had either initially —
not even `service_role`. Migration `grant_social_schema_privileges` establishes:
`service_role` full access including future tables, `authenticated` SELECT on the six
tables the public views read, `anon` nothing, and `credentials`/`oauth_states` reachable
only by `service_role`. The public views are `security_invoker`, so they check the
*caller's* rights — the grant to `authenticated` is what makes the dashboard work at all.

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

6. `sync-meta`, `sync-instagram` and `probe` pass the Meta/Instagram access token as an `&access_token=` query
   parameter. This is the convention Meta's own docs use and the token never reaches a
   client — but secrets in URLs are far more likely to end up in proxy and platform logs
   than secrets in headers. The Graph API accepts `Authorization: Bearer <token>`. Worth
   converting both, in one pass so they stay consistent. Nothing is leaking today; this is
   reducing the blast radius of a log you don't control.

**Structure**

7. `shared.ts` is byte-identical across the four collectors. Deliberate for now — they
   import it relatively and collapsing it naively breaks redeploys — but an import map or
   a published module would be cleaner.
8. No tests of any kind.
9. No CI. Deploys are manual.
10. The daily cron runs `sync-all` at 03:15 UTC, reading the service role key from Vault
   by name so no secret sits in `cron.job` or in this repo. Two things it depends on:
   the Vault secret `signal_service_role_key` must exist in the target project, and
   `timeout_milliseconds` must stay well above the real run time. pg_net defaults to 5
   seconds; a full run takes about 40. The edge function survives pg_net hanging up, so
   the data still lands — but the response is lost, and a failing sync then looks exactly
   like a working one from the job's side. That is why it is set to 120s.

**Frontend**

11. Platform selection on connect uses `window.prompt()`. It works; it's ugly.
12. The posts table caps at 200 rows with no pagination.
13. Tab state is not in the URL, so a particular platform view can't be linked or
    survive a refresh.
14. Everything renders by string concatenation into `innerHTML`. Fine at this size and
    every interpolation goes through `esc()`, but it is the first thing that will strain
    if the page grows.

The layout is overview-plus-tabs. The overview deliberately carries only metrics that
compare across platforms — followers, posting cadence, engagement rate. Views and watch
time are not on it, because YouTube reports them daily, Instagram only as 28-day totals
and TikTok not at all; putting them on shared axes would invent an equivalence that isn't
there. Each platform tab is data-driven: it reads whatever metrics that platform actually
returned, splits them into daily series and `_28d` rolling totals, and renders
accordingly. A newly connected platform populates its own tab with no code change.

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
- `CREDENTIALS.md` — the developer consoles, current as of today, and the
  connect → probe → fix → sync loop. Supersedes `SETUP.md` where they disagree.
- `SETUP.md` — schema reference and longer-form background
- `GO-LIVE.md` — hosting, Squarespace DNS, Pages and Supabase auth
- `supabase/migrations/` — the seven migrations, in order
- `supabase/functions/` — all eight functions as deployed
- `CREDENTIALS.md` — the three developer consoles and the connect → probe → fix loop
- `probe` — read-only diagnostic; returns raw API payloads, writes nothing. Use it before
  trusting any parser.
