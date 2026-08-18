# Signal — design handoff, direction 2a

Deliverable 4 of `DESIGN-BRIEF.md`: what is structural versus decorative, where design
expects reuse, and what was asked of the data layer.

Companion to `prototypes/signal-2a.html` — a single, buildless page in drop-in shape for
`index.html`. Its siblings carry the rest: **`tokens.md`** (deliverable 2, the two-layer
token rule and every value) and **`interactions.md`** (deliverable 3, states, URL scheme,
responsive, accessibility). This document does not repeat them.

Nothing here touches edge functions, the database, cron, or auth behaviour.

**Where this belongs in git.** `main` auto-deploys to the live, internet-facing portal
(`CLAUDE.md`, brief §"Git workflow"), so this work belongs on `design/prototypes` — not
`main`, and not promoted to `index.html` without a deliberate deploy decision. Design
sessions have no push credentials by design; Demetri is the deploy gate.

---

## 0 · Update for Cowork — launcher, Reads surface, polish (18 Aug 2026)

Since 2a shipped, upstream folded the mobile comp into one responsive `index.html` and the
data session added the Reads publishing queue (first-draft visuals) per
`docs/PORTAL-PUBLISH-SPEC.md`. This design copy (`prototypes/signal-2a.html`, kept in step
with the project's `Signal Portal.html`) now **leads `main`** with the work below — for
Cowork to fold into `index.html` and push. Design-only: no schema, auth, edge-function or
cron change.

**A · Launcher is the post-auth home (direction 1c).** Gate → launcher → Signal or Reads.
Two glossy slabs: Signal (periwinkle, the analytics dashboard) and Reads (Terracotta,
Aubrey North; wordmark in the AN face **Scenario** — new `@font-face`, `fonts/Scenario-700.ttf`).
New `SURFACE` router: `?surface=signal|reads`, bare URL = launcher; legacy `?view=reads`
still resolves to Reads (`applySurfaceVisibility()`/`renderSurface()`/`showSurface()`).
Back to home: rail brandrow (`#railHome`), mobile logo (`#mHome`), Reads hub link
(`#readsHub`). Idle logout arms on any surface; the gate resume label is surface-aware.

**B · Reads left the analytics rail to become its own surface** (`#reads`) — resolves
weakness #1 of `DESIGN-BRIEF-READS.md`: no scope bar, range, Sync now or briefing around a
publishing queue. Aubrey North header (Scenario eyebrow + Recoleta "Reads" + hub link +
waiting-count). The "Reads" node is removed from the rail and the mobile scope sheet.

**C · Reads polish** (rest of the brief): `.mdprev` styled to cover every markdown element;
`mdPreview()` opens links in a new tab and absolutizes relative `/reads/…` to aubreynorth.com;
animated periwinkle "Committing…" state; month-grouped Published history; guidance empty
state; mobile bottom-sheet publish confirm. Lanes stay **neutral** — Terracotta already means
negative, so the division accent wasn't mapped (brief §3, resolved consciously). Publish flow
logic unchanged (optimistic flip, re-read, Retry through the same path).

**D · Three review features** (read-only, copylock intact): faithful preview (C); client-side
**pre-flight** mirroring `publish-read`'s checks (description 140–160, slug, lane, frontmatter)
that disables a doomed publish with the reason instead of returning a failed row;
**update-vs-new awareness** (a re-publish is tagged "Update", labelled "replaces the live
version", confirm copy adjusts). Card metadata added: SEO description + tag chips.

**E · Gloss pass** — restrained specular sheen + 1px highlight on raised surfaces (auth card,
panels, KPIs, account/read cards, menu, modal, sheet) and a refined specular + periwinkle glow
on the primary action. Chrome (rail, scope bar, inputs) stays matte. Pure CSS layered into
existing `background`/`box-shadow`.

**F · Fix** — the `.acct` platform accent moved from `border-left` to an `overflow`-clipped
`::before` bar (`--acct-accent` per platform) so it can never break out of the rounded card.

**Needs a backend to finish** — the queued-vs-live **diff** ("what changed") is specced in
`PORTAL-READ-DIFF-SPEC.md` (a `read-diff` edge function; `verify_jwt`, reuses `GITHUB_TOKEN`,
read-only). The portal would render it lazily behind a "What changed" disclosure on Update cards.

**Two review-only hooks** live in this design copy and are **dropped in production**:
`signalIdleWarn()` and `signalReadsDemo()` (seeds the Reads surface so preview/pre-flight/update
are reviewable without signing in). Intentional, not drift.

**Do not change:** copylock (no copy editing, no unpublish button), the security posture, the
availability glyph set and per-account logic, one-glow-per-layout, and everything in §6.

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

## 2 · Structural vs decorative

**Structural — build once, reuse.** These carry meaning; changing them changes what the
page asserts.

- **Availability glyph set** (`.g.live/.lag/.roll/.deriv/.none/.err/.off`). Seven states.
  Filled gold = daily. Half-filled ring = lagged. Solid periwinkle = 28-day rolling.
  Dashed periwinkle ring = derived. **Hollow dashed grey = not provided by the API.**
  Terracotta = failing. Flat dash = not connected. The hollow-versus-terracotta
  distinction is the entire point of R4 — do not collapse them.
- **Cadence badges** (`.cad.live/.lag/.roll/.deriv`) — every panel states how often its
  data arrives.
- **The idle warning dialog** and its suspend-on-open rule. The countdown and the
  "presence requires a click" logic are the load-bearing parts; the bar is decoration.
- **The scope rail**, including dimmed unconnected platforms. The nav is part of the
  availability story; do not hide platforms that aren't connected.
- **Delta colouring** via `cls()` — and its `flat` case, which is not "zero", it's
  "no basis for comparison".
- **Platform pills** and the 3px account rule.
- **The briefing lede generator.** Every branch maps to a real data shape.

**Decorative — tune freely.** Panel radius, shadow depth, the pulse on the live dot,
area-fill opacity, skeleton shimmer, exact panel padding, chart tension.

---

## 3 · Reuse

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

## 4 · Requests to the data layer

**All three shipped on 2026-08-16** (migrations `20260816201608/9/10`), and
`signal-2a.html` has been rebuilt against them. Kept here as the record of why they were
asked for and what changed when they landed.

**1 · `account_id` on `social_daily_totals`** — *was the blocking one.* ✅ shipped.
The view was grouped by `day, platform, metric` only, so daily metrics could not narrow to
one account and the panel had to be labelled "Platform-wide". The view is now per-account.
**Note the grain change:** a day+metric now returns one row per account, so anything
summing across platforms without narrowing first will double-count. The client buckets by
`day|metric` over the accounts in scope, and an absent bucket stays `null` so a gap is
still a gap.

**2 · `account_id` on `social_top_posts`.** ✅ shipped.
The `platform|display_name` compound-key workaround is retired; posts now filter on
`account_id`. Same-platform duplicate display names are no longer a risk.

**3 · `access_mode` on `social.accounts`, surfaced through `social_accounts_overview`.**
✅ shipped, and `sync-youtube` writes it. Values are `+`-joined components: `public:key`,
`public:oauth`, `analytics`, `analytics:failed`, `none`. **A standalone `analytics`
component means daily analytics genuinely work.** Three things now key on the value rather
than string-matching a `sync_runs.message` sentence:

- The YouTube daily empty state is **definite**: a channel with no `analytics` component
  reports public totals only, permanently, and the copy says so instead of naming two
  possible causes.
- `analytics:failed` renders as a **fault** (terracotta) rather than a gap — the one case
  where an absent daily series really is broken.
- The availability matrix drops from per-platform to **per-account** accuracy: under a
  scope where no account has analytics, the daily rows show "not provided" instead of
  "lags 2–3 days". It only qualifies when every account in scope agrees, so a mixed
  platform view stays honest.
- Account cards carry a "Public only" or "Analytics failing" chip — silent when the mode
  is unknown or full, since a badge on everything says nothing.

---

## 5 · Open items for the code pass

Known, deliberate, and not defects. **Two were closed by the code pass on 17 Aug and are
recorded here as settled, not outstanding** — items 1 and 5.

1. ~~**No focus trap** in the connect modal.~~ **Closed.** `trapFocus(container)` traps Tab
   in capture on both modals and returns a teardown, re-querying focusables each press so
   it survives the Connect modal's redraws. Escape stays with each modal's own handler.
2. **200-row post cap, no pagination** (`CLAUDE.md` rough edge 12, still open).
3. ~~**Mobile is a collapse, not a design.**~~ **Addressed — see `prototypes/signal-mobile.html`.**
   A dedicated mobile-first build: scope moves to a bottom sheet, the two write-actions to a
   thumb-zone bar, the posts table becomes cards, the availability matrix transposes to
   per-platform cards. Same tokens, same five views, same data-truth logic. It is a
   separate file for review; the intended end state is folding its breakpoints into one
   responsive `index.html` rather than shipping two files — that merge is the code pass's.
4. **Every render rebuilds and re-instantiates both charts.** Fine at five accounts; the
   first thing that will feel slow. Sorting the posts table re-renders the page.
5. ~~**`spanGaps: true` on the audience chart**~~ — **decided: now `false`.** A missed sync
   shows a hole rather than interpolating, which matches the daily series (`null`, not
   `0`, so YouTube's lag reads as absence). Gaps now mean the same thing on every chart in
   the product.
6. **`innerHTML` string concatenation throughout** (`CLAUDE.md` rough edge 14). Kept
   deliberately to match the existing file; every interpolation goes through `esc()`.
   Note the two places that build strings for `textContent` instead — the briefing lede —
   which must *not* be escaped.

Closed by this work: rough edge 11 (`window.prompt()` connect) and 13 (tab state not in
the URL). Closed by the code pass while promoting 2a to `index.html`: the modal focus trap
and the `spanGaps` decision above.

Still genuinely open: the 200-row post cap (2), mobile (3), chart re-instantiation (4),
`innerHTML` concatenation (6), and arrow-key roving focus in the profile menu — Tab works,
arrows don't.

---

## 6 · Unchanged, and to stay that way

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
