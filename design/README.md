# Signal — design pass

Everything the design pass produced, mapping to `DESIGN-BRIEF.md` §4 deliverables.

**This belongs on `design/prototypes`, never `main`.** `main` auto-deploys to the live,
internet-facing portal. Promoting a prototype to `index.html` is a deploy decision for
Demetri, not a file move.

| # | Deliverable | File |
|---|---|---|
| 1 | Prototype directions | `prototypes/directions-1a-1b-1c.html`, `prototypes/signal-2a.html` |
| 2 | Token sheet | `tokens.md` |
| 3 | Interaction notes | `interactions.md` |
| 4 | Handoff note for the code pass | `handoff.md` |

## The prototypes

**`prototypes/signal-2a.html` — the chosen direction.** A working page, not a mockup:
magic-link and passkey sign-in, live reads from the five `social_*` views, real connect
flow, idle logout. Single file, no build step, drop-in shape for `index.html`. Signed out
it shows the auth gate — correct, since nothing is visible pre-auth. It needs `fonts/`
alongside it, which the repo now has.

**`prototypes/directions-1a-1b-1c.html` — the exploration.** The three earlier directions
side by side (1a Console, 1b Briefing, 1c Board) plus the token sheet rendered visually.
Self-contained; pan and zoom. Figures here are illustrative, modelled on the real data
shape — this file is the argument for 2a, not a live view. For anything real, use
`signal-2a.html`.

2a is **1c's scope rail plus 1b's briefing header**: the rail is navigation, the lede is
content, and merging them forces one rule — the summary follows the scope.

## Reading order

`handoff.md` first — §6 records the three data-layer requests, all now shipped, and the
one grain change that would silently corrupt figures if code reads it stale. Then
`tokens.md` for what to bind to CSS custom properties, then `interactions.md` for states
and URL scheme.

Built against `cunningcorp/portal@a31cfe3742cd`, 17 Aug 2026.
