# Signal — design handoff, direction 2a

Companion to `signal-2a.html`. That file is the deliverable: a single, self-contained,
buildless page, drop-in for `index.html`. This document is deliverable 4 of
`DESIGN-BRIEF.md` — what is structural versus decorative, what to reuse, the interaction
contract, and the three things that are requests to the data layer rather than
assumptions.

Nothing here touches edge functions, the database, cron, or auth behaviour.

**Where this belongs in git.** `main` auto-deploys to the live, internet-facing portal
(`CLAUDE.md`, brief §"Git workflow"), so this work belongs on `design/prototypes` — not
`main`, and not promoted to `index.html` without a deliberate deploy decision. Design
sessions have no push credentials by design; Demetri is the deploy gate.

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

**Fonts:** all five Handbook faces are now committed to `fonts/` in the repo
(`GlamourAbsolute-400`, `GlamourAbsoluteExtended-400`, `Graphik-400`, `Graphik-600`,
`Recoleta-300`) and the `@font-face` rules point at them. Nothing further to do.

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

**The one deliberate ambiguity.** ~~The YouTube daily empty state names two possible
causes~~ — **resolved.** `access_mode` shipped, so the empty state is now definite: a
channel without the `analytics` component reports public totals only and always will.

**Idle sign-out.** 66 minutes of inactivity, warned at 90 seconds, with a designed
signed-out state on the gate (brief §1.1 asks for a treatment, not a status line). Three
design rules:

- *A silent sign-out looks like a bug.* Landing on an auth gate with no explanation reads
  as "it logged me out for no reason" — the same missing-by-design versus
  missing-because-broken confusion R4 exists to remove. So the warning states the rule
  before it happens, and the gate states what happened after.
- *`mousemove` must not dismiss it.* The activity listeners re-arm on any movement, so a
  drifting cursor would silently cancel the warning and the user would never learn the
  rule. While the dialog is open, auto-rearm is suspended and only an explicit click — or
  Escape, which means "I'm here" — counts as presence.
- *Coming back should resume, not restart.* No reload happens, so the URL still holds the
  scope. The gate names the view being held ("Waiting for you: Instagram · 30 days"), read
  from the URL rather than from data, and the send button becomes "Email me a link to
  resume". Where passkeys exist the passkey route is marked *Fastest* — only here, where
  someone is trying to get back in; the documented hierarchy is otherwise unchanged.
  A deliberate sign-out clears the URL, because leaving on purpose shouldn't offer to
  resume.

The dialog is `role="alertdialog"`, focus lands on "Keep me signed in", and the countdown
is `aria-hidden` with a single announcement instead: a live region ticking every second is
unusable. It stays in gold and periwinkle because a scheduled sign-out is routine, not a
failure — terracotta is reserved for things that actually broke. Sign-out does **not**
reload, so the URL keeps the scope and signing back in returns to the same view; the gate
prefills the email from the in-memory session, with nothing written to storage.

Nobody can wait 66 minutes to review a dialog, so `signalIdleWarn()` in the console opens
it immediately and `signalIdleWarn(10)` opens it with 10 seconds on the clock. It only
shortens the clock — remove it if you'd rather not ship a test hook.

**Sign-in.** Two methods, and the design keeps them visibly separate: the email link is
primary (periwinkle, the layout's one glow), then an `or` rule, then the passkey button
outlined. Stacked without that seam they read as one control and the passkey looks like a
subtitle. Passkey controls are hidden unless `window.PublicKeyCredential` exists, so the
card is honest on unsupported devices, and every passkey failure points back at the email
route — a passkey problem must never lock anyone out. "Add a passkey" sits in the rail
foot, where you are already signed in.

Two fixes worth keeping: the email field overrides `-webkit-autofill` (Chrome and Safari
paint their own yellow field and ignore `background-color`; the 100px inset shadow is the
only way to repaint it), and `.msg` reserves two lines so the card doesn't jump when a
message appears. The subhead no longer claims email is the only way in.

**Responsive.** Panel grids collapse at 1150px. The rail goes full-width and static at
900px — that is a collapse, not a designed mobile layout. See §7.

**Accessibility.** `aria-sort` on sortable headers with nulls sinking; `aria-current` on
rail nodes; `aria-pressed` on range and filter chips; `:focus-visible` throughout;
`aria-live` toast; modal has `role="dialog"`/`aria-modal` and Escape/scrim close.

---

## 6 · Requests to the data layer

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
