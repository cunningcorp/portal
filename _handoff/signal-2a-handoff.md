# Signal — design handoff, direction 2a

Companion to `signal-2a.html`. That file is the deliverable: a single, self-contained,
buildless page, drop-in for `index.html`. This document is deliverable 4 of
`DESIGN-BRIEF.md` — what is structural versus decorative, what to reuse, the interaction
contract, and the three things that are requests to the data layer rather than
assumptions.

Nothing here touches edge functions, the database, cron, or auth behaviour.

---

## 1 · What changed, and why

Direction 2a is **1c's scope rail plus 1b's briefing header**. The rail is navigation;
the lede is content. They occupy different slots, and merging them forces one rule:
**the summary follows the scope.** A summary still describing four accounts while you
read one is worse than no summary.

Against the brief's requirements:

| Req | How |
|---|---|
| R1 · platform → account | The rail *is* the hierarchy. Scope is a place you navigate to, so it survives refresh and links. Account cards are entry points, not dead ends. |
| R2 · filters | Post-type chips built from the `post_type` values actually present; global range retained. |
| R3 · refined overview | Comparable metrics only, led by a generated narrative. Week-one shapes are first-class, not an afterthought. |
| R4 · availability legible | A dedicated `--avail-*` token family, cadence badges on every panel, and a matrix that distinguishes missing-by-design from missing-because-broken. |
| R5 · worst interactions | Real connect modal (incl. the YouTube handle step), loading skeletons, per-panel empty states, URL-addressable scope. |
| R6 · brand via tokens | Two-layer token sheet; both standing exceptions preserved. |

---

## 2 · Tokens — the two-layer rule

`:root` has exactly two layers, and **hex appears only in the first**.

1. **Brand layer** — the Handbook palette verbatim (`--brand-plum`, `--brand-gold`,
   `--brand-peri`, `--plat-youtube`…). Nothing outside layer 2 may reference these.
2. **Semantic layer** — what components actually use.

A palette change is therefore a one-line edit in layer 1. If you find yourself writing a
hex anywhere else, the token is missing — add it rather than inline it.

| Family | Tokens | Note |
|---|---|---|
| Surface | `base` `raised` `overlay` `sunken` | Page / panel / control / well |
| Border | `subtle` `default` `strong` | Inside panel / outlines it / selected edge |
| Text | `primary` `secondary` `tertiary` `on-accent` | `on-accent` is for the periwinkle button only |
| State | `positive` `negative` `progress` `neutral` | Gold is the light, so gold is up |
| Data | `youtube` `instagram` `facebook` `tiktok` | Encoding only — see §8 |
| Availability | `live` `lagged` `rolling` `absent` `error` | New family; the R4 workhorse |
| Type | `--font-display` `--font-head` `--font-body` + 7 sizes | Roles unchanged from the Handbook |
| Scale | `--space-1…7`, `--radius-sm/md/lg/pill` | 4px base |
| Motion | `--dur-fast/base`, `--ease-out` | Short. This is a tool, not a show. |

JS reads platform colours back out of the tokens via `cssVar()` so Chart.js and CSS
cannot drift apart. Keep that — do not re-declare the hexes in the script.

**Fonts:** all four Handbook faces exist and the `@font-face` rules already point at
`fonts/`. `README.md` says they are in no repo; they are in the design project and were
used to design this. Drop `GlamourAbsoluteExtended-400`, `GlamourAbsolute-400`,
`Graphik-400` and `Graphik-600` into `fonts/` and the page picks them up with no code
change.

---

## 3 · Structural vs decorative

**Structural — build once, reuse.** These carry meaning; changing them changes what the
page asserts.

- **Availability glyph set** (`.g.live/.lag/.roll/.deriv/.none/.err/.off`). Seven states.
  Filled gold = daily. Half-filled ring = lagged. Solid periwinkle = 28-day rolling.
  Dashed periwinkle ring = derived. **Hollow dashed grey = not provided by the API.**
  Terracotta = failing. Flat dash = not connected. The hollow-versus-terracotta
  distinction is the entire point of R4 — do not collapse them.
- **Cadence badges** (`.cad.live/.lag/.roll/.deriv`) — every panel states how often its
  data arrives.
- **The scope rail**, including dimmed unconnected platforms. The nav is part of the
  availability story; do not hide platforms that aren't connected.
- **Delta colouring** via `cls()` — and its `flat` case, which is not "zero", it's
  "no basis for comparison".
- **Platform pills** and the 3px account rule.
- **The briefing lede generator.** Every branch maps to a real data shape.

**Decorative — tune freely.** Panel radius, shadow depth, the pulse on the live dot,
area-fill opacity, skeleton shimmer, exact panel padding, chart tension.

---

## 4 · Reuse

Small enough to stay one file, but these are the seams if it ever splits:

- `acctCard(a)` — used by the Accounts panel; the same shape is reused for rolling-total
  tiles and the Overview cadence cards. If you componentise anything, start here.
- `postsPanel()` / `postRows()` — one table, scope-filtered.
- `availabilityPanel()` — reads the `AVAIL` constant, not a query.
- `briefing()` — pure function of `DATA` + `SCOPE`; trivially unit-testable, and the
  first thing worth a test.
- `scoped()` / `scopePlatform()` — **the only** correct way to ask what is in scope. Any
  new panel must go through them or it will silently ignore the rail.

---

## 5 · Interaction contract

**URL scheme.** `?platform=<slug>` · `?account=<uuid>` · `?range=7|30|90` · `?type=<post_type>`.
Defaults omitted. `pushState` on change, `popstate` restores — back button works, links
are shareable. On load, a scope pointing at a vanished account falls back to Overview via
`replaceState` so the bad URL doesn't persist.

**States, per panel.** Loading → skeletons (never a spinner, never a blank). Empty → its
own wording per panel, never a shared "no data"; the empty state says *why* and, where the
cause is ambiguous, names both possibilities. Error → message plus retry. Filtered → the
scope bar names it and offers Clear.

**The one deliberate ambiguity.** The YouTube daily empty state names two possible causes
(no Analytics consent versus nothing synced in the window) because the UI genuinely cannot
tell them apart yet — see §6. When `access_mode` lands, replace that sentence with the
definite one.

**Responsive.** Panel grids collapse at 1150px. The rail goes full-width and static at
900px — that is a collapse, not a designed mobile layout. See §7.

**Accessibility.** `aria-sort` on sortable headers with nulls sinking; `aria-current` on
rail nodes; `aria-pressed` on range and filter chips; `:focus-visible` throughout;
`aria-live` toast; modal has `role="dialog"`/`aria-modal` and Escape/scrim close.

---

## 6 · Requests to the data layer

Three one-line changes on views that already join `social.accounts`. Flagged, per the
brief, rather than assumed. The page works without them; each one removes a compromise.

**1 · `account_id` on `social_daily_totals`** — *the blocking one.*
The view groups by `day, platform, metric` only, so there is no per-account daily
breakdown, even though `social.daily_metrics` carries `account_id`. R1 asks that scope
narrow *every* panel; daily metrics are the one panel that cannot comply. Today the panel
is labelled "Platform-wide" and says so, which is honest but not what was asked for.

**2 · `account_id` on `social_top_posts`.**
The view exposes `account` (`a.display_name`) and `handle` but no id, so posts can only be
tied to an account by name — and the same brand name legitimately runs on several
platforms (`display_name` is nullable too). The page works around it with a compound
`platform|display_name` key, which kills cross-platform collision; same-platform duplicates
remain theoretically possible. Add `a.id as account_id` and delete the workaround.

**3 · `access_mode` on `social.accounts`, surfaced through `social_accounts_overview`.**
`sync-youtube` computes a mode per channel — `public:key+analytics` versus `public:key`
alone, which has no token and therefore *never* has daily figures. The string isn't
persisted, though the no-token case is recorded as free text:
`finishRun(…, token ? undefined : "public data only; Analytics needs OAuth from this channel")`.
Sync health renders that message on every status so it does surface — but the UI is
string-matching a sentence. A real column lets the availability matrix go from
per-platform to per-account accuracy.

---

## 7 · Open items for the code pass

Known, deliberate, and not defects:

1. **No focus trap** in the connect modal. Escape and scrim-click work; Tab can leave.
2. **200-row post cap, no pagination** (`CLAUDE.md` rough edge 12, still open).
3. **Mobile is a collapse, not a design.** Below 900px the rail stacks above the content;
   a five-account internal tool may not need more, but it is a decision, not an oversight.
4. **Every render rebuilds and re-instantiates both charts.** Fine at five accounts; the
   first thing that will feel slow. Sorting the posts table re-renders the page.
5. **`spanGaps: true` on the audience chart**, inherited from the framework — a missed
   sync interpolates rather than showing a hole. Now that gaps are meaningful elsewhere
   (daily series render `null`, not `0`, precisely so YouTube's lag reads as absence),
   this deserves a decision either way.
6. **`innerHTML` string concatenation throughout** (`CLAUDE.md` rough edge 14). Kept
   deliberately to match the existing file; every interpolation goes through `esc()`.
   Note the two places that build strings for `textContent` instead — the briefing lede —
   which must *not* be escaped.

Closed by this work: rough edge 11 (`window.prompt()` connect) and 13 (tab state not in
the URL).

---

## 8 · Unchanged, and to stay that way

Carried over from `CLAUDE.md` and `README.md` without alteration:

- Single file, no build step. Chart.js and Supabase from CDN.
- The mark and the wordmark. Signal is not renamed.
- Reads only the five `social_*` views, with the publishable key plus a session.
- Platform colours as data encoding — chart strokes, pills and the account rule only.
  Never a surface, never a button.
- Semantic states from the palette; **one glow per layout**, periwinkle reserved for the
  primary action.
- No signup affordance, nothing visible pre-auth, `shouldCreateUser: false`.
- The overview's exclusion of views and watch time. It now defers them explicitly rather
  than omitting them silently: Overview lists each platform's cadence and sends you to a
  platform scope to read the series.

Reused from the existing frontend rather than reinvented: the `CAVEAT` map, `METRIC_LABEL`,
the `_28d` rolling-total convention, `esc()`, `fmt()`/`signed()`/`ago()`/`shortDate()`,
null-sinking sort, and the data-driven metric rendering — so a newly connected platform
still populates with no code change.
