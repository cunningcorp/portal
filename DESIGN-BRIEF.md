# Signal — design brief

You are redesigning a working internal analytics portal. The data layer is live, proven
against real APIs, and out of scope: your job is the interface. Produce prototypes, iterate
with Demetri, and hand the chosen direction to the code pass in a form it can implement
against the site framework without reverse-engineering pixels.

Two hard rules before anything else:

1. **No hardcoded values.** Every colour, typeface, spacing step, radius and duration is a
   design token. The deliverable includes the token sheet. The code pass will bind tokens
   to CSS custom properties, so a prototype that bakes hex values into components is
   rework, not progress.
2. **Do not invent data.** The data contract below is exhaustive. If a design needs a
   number that isn't in it, the design is wrong — or it's a feature request for the data
   layer, which is a conversation, not an assumption. This matters because the platforms
   genuinely differ: designing a daily-views chart for Instagram would be designing a lie.

Assumed implementation target: the same Astro static-site setup as the `aubreynorth`
repo, deployed to GitHub Pages. Flag to Demetri if that assumption matters to a decision.

---

## 1 · What exists today — full audit

One HTML file (`index.html`, ~37KB), no build step. Supabase for auth and data. Chart.js
via CDN. Everything below is what a signed-in user can currently see or do.

### 1.1 Auth gate

Full-viewport card: wordmark, product name, one email field, one button, magic-link flow.
Status line for feedback. `shouldCreateUser: false` — unknown emails are refused; there is
no signup and there must never appear to be one. This screen is the only thing an
unauthenticated visitor ever sees, and the page is on the public internet.

### 1.2 Header (sticky)

- Brand mark (periwinkle orbit + gold dot SVG) and product name, with a "Cunning Corp"
  suffix chip
- Date-range switcher: 7d / 30d / 90d segmented control. Global — affects every view.
- Connect account (opens a `window.prompt()` asking which platform — the single worst
  interaction in the product, replace it)
- Sync now (primary action, periwinkle; disabled state with label swap while running)
- Sign out
- Below the bar: a tab strip — Overview plus one tab per platform that has at least one
  account, each with a platform-colour dot

### 1.3 Overview tab

- Five KPI cards: total followers (with 7d/28d deltas), posts published in range with
  weekly cadence, engagement rate in range (interactions ÷ views, from post metrics),
  platform count, account count
- Audience chart: one line per platform, followers over time, area-filled
- Top posts table (see 1.5)
- Accounts panel: one card per account (see 1.6)
- Sync health panel: last run per account — status LED (gold ok / terracotta error /
  periwinkle running), platform pill, account, relative time, error text in tooltip
- Empty state when nothing is connected: message plus three connect buttons

The overview deliberately excludes views and watch time, because they don't compare across
platforms (see the data contract). That editorial decision should survive the redesign.

### 1.4 Platform tabs (one per platform, data-driven)

- KPI row: followers with deltas, lifetime views, posts; conditionally views/reach/watch
  time when that platform has the daily series
- Daily activity chart: headline metric as bars in the platform colour, other daily
  metrics as thin lines on a right axis. Renders whatever metrics exist — a new platform
  populates without code changes, a principle to preserve
- A caveat line per platform stating in plain words what that platform does not provide
- "Last 28 days" grid: rolling-total tiles (Instagram only today)
- Audience line for that platform
- Accounts panel filtered to the platform
- Posts table filtered to the platform

### 1.5 Posts table

Columns: thumbnail, platform pill, account, title (links out), published date, views,
likes, comments, engagement %. Click-to-sort on every column with `aria-sort`; nulls always
sink. Capped at 200 rows, no pagination. Titles truncate with ellipsis.

### 1.6 Account cards

Avatar, display name, platform + handle, left border in platform colour. Rows: followers,
7d movement (signed, coloured, with %), lifetime views, posts, as-of date.

### 1.7 Feedback and states

Single toast (aria-live) for sync results and query failures. Focus-visible outlines
throughout. Charts silently render empty when a range has no data — known weakness, no
per-chart empty state. Known gaps worth designing for: no loading skeletons (data pops in),
no URL state (tabs don't survive refresh or linking), no mobile-considered layout beyond
grid collapse.

### 1.8 Out of scope for design

Edge functions, database, cron, the connect/OAuth flows' server side, `robots.txt`/auth
posture. The OAuth consent screens are Google/Meta property and cannot be styled.

---

## 2 · The data contract

Everything the interface can truthfully show. Cadences verified against the live database,
not the platforms' marketing.

### 2.1 Per-account, all platforms (daily snapshot)

Followers, lifetime views, post count — one point per day from the day the account was
connected. **History starts at connection; no platform backfills follower history.** The
audience chart is honest but short until weeks pass. Design for sparse early data.

### 2.2 YouTube

| Data | Cadence | Caveats |
|---|---|---|
| views, watch time (min), avg view duration, subscribers gained/lost, likes, comments, shares | daily series, 35-day backfill window | **lags 2–3 days** — the newest days are always missing; today: data ends 13 Aug on 16 Aug |
| channel totals, per-video views/likes/comments | captured daily | subscriber count is exact below 1,000, then rounded to 3 significant figures; hidden counts stored as null |
| video list | 50 most recent | shorts vs long-form distinguished |

### 2.3 Instagram

| Data | Cadence | Caveats |
|---|---|---|
| reach | daily series | the **only** daily series Instagram provides |
| views, likes, comments, shares, saves, replies, accounts engaged, total interactions | **rolling 28-day totals** — one figure per sync, no per-day breakdown | cannot be charted over time as-is; today shown as tiles |
| followers gained/lost | rolling 28d | **returns nothing below 100 followers** (Meta threshold) — all three accounts are currently below it |
| per-post views/likes/comments/shares/saves | captured daily | 40 most recent posts |
| post types | reels, posts, stories | stories expire in 24h and are usually missed by a daily sync |

There is no daily views series for Instagram and there never will be on this API. Any
design showing Instagram views-per-day is wrong.

### 2.4 TikTok (built, not yet connected — design for it)

| Data | Cadence | Caveats |
|---|---|---|
| followers, likes, views | cumulative totals only | daily movement is **derived** by differencing snapshots — needs 2+ days of history, approximate, and a missed day merges into the next |
| per-video views/likes/comments/shares | captured daily | 20 most recent |

### 2.5 Facebook Pages (built, no Page exists — lowest priority)

Daily reach, engagements, video views, fans gained; page fan count; recent posts. Meta is
actively retiring Page metrics, so treat any Facebook design as provisional.

### 2.6 Cross-platform comparability — the core editorial problem

Safe to aggregate and compare: **followers, follower deltas, post counts, posting
cadence, engagement rate on posts**. Not comparable: views (YouTube daily vs Instagram
28d-total vs TikTok cumulative-derived), watch time (YouTube only), reach (Instagram
daily, YouTube absent). The current design's answer is to keep the overview to comparable
metrics only and push the rest to platform tabs. The redesign may find a better answer,
but it may not paper over the difference.

### 2.7 Freshness signals available to the UI

Per-account: last snapshot date, last sync run with status and error text. Per-platform:
the lag caveats above. Sync cadence: 03:15 UTC daily, plus manual. The redesign should
surface freshness far better than today — see requirement R4.

---

## 3 · What Demetri wants — requirements

### R1 · Hierarchy: platform → account

Platform tabs stay, but each becomes a two-level view: **aggregated platform view by
default, with a filter to any single account.** Concretely: the Instagram tab shows all
three accounts summed/overlaid, and one interaction (chips, dropdown — designer's call)
narrows every panel on the tab — KPIs, charts, tiles, posts — to one account. Account
cards should act as entry points to that filtered view, not dead-ends. Filter state should
be legible at a glance: you should never wonder whether you're looking at one account or
all of them.

### R2 · Filters

Beyond the account filter: post-type filter on post tables (shorts/videos; reels/posts),
and the existing global date range rethought if needed. Anything else the designer
proposes should justify itself against real use — this is a five-account internal tool,
not a SaaS.

### R3 · Refined overview

Keep the comparable-metrics-only principle. Add better narrative: what changed lately,
which account is moving. Design for the sparse-data reality of week one.

### R4 · Data availability made legible

Demetri's explicit ask: the portal should teach its reader what each platform offers and
at what cadence, so a gap reads as "Instagram doesn't provide this" rather than "the
portal is broken." Today this is one caveat sentence per tab. Candidates: a availability
matrix on the overview, per-panel cadence badges ("daily", "28-day rolling", "derived",
"lags 2–3 days"), freshness stamps per panel. Make missing-by-design visually distinct
from missing-because-error. This requirement is as important as R1.

### R5 · Replace the worst interactions

The `prompt()` connect flow becomes a real UI: platform picker; for YouTube a channel
handle/ID input (the API can't discover channels — see `CLAUDE.md` for why); clear
communication that connecting opens a provider consent window. Add per-chart/panel empty
states, loading skeletons, and URL-addressable tabs and filters (a filtered view should
survive refresh and be shareable).

### R6 · Brand, applied through tokens

Palette and type per the Cunning Corp Brand Handbook (table in `README.md`): Plum
`#241B30`, Plum Deep `#191220`, Gold `#C8A24C`, Gold Soft `#E3C57E`, Periwinkle `#8E8BD8`,
Paper `#FAF6EE`; division accents Terracotta/Slate/Teal. Type: Glamour Absolute Extended
(display), Recoleta (headings, figures), Graphik (body/UI) — Recoleta is the only file
currently in the repo; the others are declared with graceful fallbacks.

Two standing exceptions, documented in `README.md`, to preserve unless explicitly
overturned with a better answer: platform colours (YouTube red etc.) are data encoding,
confined to chart strokes and pills; and semantic states draw from the palette (gold up,
terracotta down, periwinkle in-progress), with "one glow per layout" held by reserving
periwinkle for the primary action.

---

## 4 · Deliverables

1. **Two or three prototype directions**, self-contained HTML, same Supabase views the
   current portal reads (`social_accounts_overview`, `social_account_series`,
   `social_daily_totals`, `social_top_posts`, `social_sync_health` — all readable with the
   publishable key plus a session). Prototyping against real data is the point: the real
   data is sparse, lopsided (42 posts vs 4) and has holes, and a design that only works
   with lorem-ipsum numbers fails here. Include the week-one state and the two-years-in
   state.
2. **A token sheet**: named tokens for every colour role, type style, spacing step,
   radius, shadow, duration. Semantic names (`--surface-raised`, not `--plum-lift`).
3. **Interaction notes** per screen: states (loading/empty/error/filtered), URL scheme
   for tabs and filters, responsive behaviour.
4. **A handoff note for the code pass**: what is structural vs decorative, where design
   expects components to be reused, anything requiring a new database view (flag these —
   they're a request to the data layer, not something to assume).

Iterate with Demetri between directions. He reacts decisively to seeing things — show
early, show real data, expect a strong steer.

## 5 · What not to do

- Don't touch the data layer, the edge functions, or auth behaviour.
- Don't add a build step to the prototypes; single-file HTML keeps review friction zero.
- Don't design features that need per-day Instagram views, follower history before
  connection date, or TikTok timeseries — the contract says no.
- Don't soften the security posture: no signup affordance, no data visible pre-auth.
- Don't rename Signal or restyle the wordmark; the mark is settled.

## Reference

- `CLAUDE.md` — engineering handover: what's proven, locked decisions, YouTube's
  two-mode access design and why
- `README.md` — brand tokens, deploy, security posture
- `CREDENTIALS.md` — how accounts get connected (informs the connect-flow redesign)
- Live portal: portal.cunningcorp.com · repo: `cunningcorp/portal`
