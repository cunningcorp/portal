# Interaction notes

Deliverable 3 of `DESIGN-BRIEF.md`. States, URL scheme and responsive behaviour, per
screen. Implemented in `prototypes/signal-2a.html`.

---

## URL scheme

Scope and view state live in the query string, so a filtered view survives refresh and can
be pasted to someone else (R5).

| Param | Values | Default (omitted) |
|---|---|---|
| `platform` | `youtube` · `instagram` · `tiktok` · `facebook` | Overview |
| `account` | account uuid | — |
| `range` | `7` · `30` · `90` | `30` |
| `type` | any `post_type` present in scope | `all` |

`platform` and `account` are mutually exclusive; `account` wins if both appear.
`pushState` on change, `popstate` restores — the back button walks scope history.

Two guards, both because a URL outlives the data it described:

- A scope naming an account or platform that no longer exists **falls back to Overview via
  `replaceState`**, so the bad URL doesn't persist to the next refresh.
- A `type` absent from the current scope resets to `all`, rather than filtering the table
  to nothing with no chip visible to escape from.

A deliberate sign-out clears the query string; an idle sign-out keeps it, because one is
leaving and the other is being interrupted.

---

## Auth gate

The only thing an unauthenticated visitor sees. No signup affordance anywhere.

**Default.** Wordmark, product name, "Access is by invitation — there is no sign-up",
email field, primary "Send sign-in link". Where `window.PublicKeyCredential` exists: an
`or` rule, then an outlined passkey button and a line saying what that means in practice
("Face ID, Touch ID or a security key on this device"). The two methods need that visible
seam — stacked without it they read as one control and the passkey looks like a subtitle.

**Unsupported browser.** Passkey controls and the `or` rule stay hidden, so the card never
offers something that cannot work.

**Sending.** Button disabled. Result goes to a status line that reserves two lines of
space, so the card doesn't jump when a message appears. Errors are terracotta; success is
secondary text.

**Signed out for inactivity** (brief §1.1 asks for a designed treatment, not a status
line). A gold-ruled notice replaces the intro: what happened, the rule that caused it, and
— the part that earns the space — **the view being held**, read from the URL: "Waiting for
you: Instagram · 30 days". The email is prefilled from the in-memory session (nothing is
written to storage), the primary button becomes "Email me a link to resume", and the
passkey route is marked *Fastest* because it resumes instantly where the email round-trip
does not. That mark appears only here.

**Autofill.** The email field overrides `-webkit-autofill`: Chrome and Safari paint their
own yellow field and ignore `background-color`, so a 100px inset shadow repaints it and a
long transition suppresses the load flash.

---

## Idle logout

66 minutes without interaction, warned at 90 seconds.

**The warning** is `role="alertdialog"`, focus on "Keep me signed in", Escape means *I'm
here* (dismissing a warning is presence, not consent to leave). The countdown is
`aria-hidden` with a single spoken announcement instead — a live region ticking every
second is unusable. A depleting gold bar carries the time visually. It stays gold and
periwinkle: a scheduled sign-out is routine, and terracotta is reserved for faults.

**The rule that makes it work:** while the dialog is open, auto-rearm is **suspended**. The
activity listeners re-arm on `mousemove`, so without this a drifting cursor would silently
cancel the warning and the user would never learn the rule. Only an explicit click or
Escape counts as presence.

Discoverability: the profile menu states the rule while signed in, so the sign-out is known
before it happens rather than only explained afterwards.

Testing: `signalIdleWarn()` in the console opens it immediately; `signalIdleWarn(10)` with
10 seconds on the clock. Nobody can wait 66 minutes to review a dialog. **The hook is kept
in this prototype and was deliberately dropped from the shipped `index.html`** — a review
artifact needs it, production doesn't. That is the one intentional difference between the
two files.

---

## Shell

**Rail (248px, sticky).** Scope *is* navigation: Overview, then each platform, then its
accounts indented beneath. Unconnected platforms **stay visible and dimmed** with a
"Connect" affordance — the nav is part of the availability story, so hiding them would lose
that. `aria-current` marks the selected node. Foot: freshness dot, next-run line, "Sync
now" (the one glow), "Connect account".

**Scope bar (sticky).** Names the current scope in words — "Instagram · 3 accounts" — with
a Clear chip when narrowed, the range switch, and the profile avatar. You should never
wonder whether you're looking at one account or all of them.

**Profile menu.** Behind the avatar, because the rail is scope and a passkey has nothing to
do with which account you're reading. Holds the signed-in email, "Add a passkey", the idle
rule, and Sign out. Escape closes and returns focus to the avatar; outside click closes;
focus lands on the first item on open. *Open item: no arrow-key roving focus — Tab works,
arrows don't.*

---

## Panel states

Every panel owns its own wording. There is no shared "no data".

**Loading.** Skeletons shaped like the content that's coming — never a spinner, never a
blank. Shimmer is suppressed under `prefers-reduced-motion`.

**Empty, and this is the R4 work.** Each empty state says *why*, and the glyph says which
kind of absence:

| Situation | Treatment |
|---|---|
| Nothing connected at all | Message + four connect buttons |
| No snapshots in range | Hollow ring · "No snapshots in the last N days" |
| Platform reports rolling totals only | Solid periwinkle · "one rolling 28-day figure, not per day" |
| Account has no Analytics consent | Hollow ring · "reports public totals only … absent by design, not missing" |
| Analytics call failed last run | **Terracotta** · "a fault, not a gap — see Sync health" |
| No posts in scope | In-table row, not a panel swap |

The fourth and fifth rows are only possible because `access_mode` is persisted. Before it,
the UI had to name two possible causes and send the reader to Sync health.

**Error.** The message from Postgres verbatim, plus a retry that re-runs the load.

**Filtered.** Scope bar names it; Clear returns to Overview; the URL reflects it.

---

## Charts

**Audience** groups by platform at Overview and by **account** under a narrowed scope, so
three Instagram accounts stop being one indistinguishable line. Dashed strokes separate
accounts within a platform's single colour.

**Daily activity** renders whatever metrics exist — headline as bars in the platform
colour, others as thin lines on a right axis — so a newly connected platform populates with
no code change. A day with no row is `null`, **not `0`**: YouTube's 2–3 day lag would
otherwise draw a cliff to the floor and read as "we lost all our views".

Overview deliberately charts no daily series at all. Views, reach and watch time aren't
comparable, so it lists each platform's cadence and defers to a platform scope — preserving
the editorial decision brief §1.3 says must survive.

*Open item: the audience chart now uses `spanGaps: false` — a missed sync shows a hole
rather than interpolating, matching the daily series. Decided with the code pass 17 Aug.*

---

## Responsive

Panel grids collapse to one column at **1150px**. The rail goes full-width and static at
**900px** — that is a collapse, not a designed mobile layout. A five-account internal tool
may not need more, but it's a decision, not an oversight.

## Accessibility

`aria-sort` on sortable headers with nulls always sinking · `aria-current` on rail nodes ·
`aria-pressed` on range and post-type controls · `:focus-visible` throughout ·
`aria-live="polite"` on the toast and auth status · `role="dialog"`/`aria-modal` on Connect
and `role="alertdialog"` on the idle warning, both closing on Escape and scrim click ·
`prefers-reduced-motion` disables shimmer, pulse and the running LED.

Both modals trap Tab (`trapFocus`, added by the code pass 17 Aug) and close on Escape and
scrim click.

*Open item: the profile menu is a `role="menu"` without arrow-key roving focus — Tab
works, arrows don't.*
