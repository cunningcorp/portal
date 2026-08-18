# Signal — design pass

Everything the design pass produced, mapping to `DESIGN-BRIEF.md` §4 deliverables.

**Shipped.** As of 17 Aug 2026 direction 2a is `index.html` on `main` and deployed to the
live portal. This folder is the record of how it got there, plus the prototype kept in
review form.

One consequence worth knowing: `main` auto-deploys, so `/design/prototypes/signal-2a.html`
is a real URL on the live host. Harmless — `robots.txt` is `Disallow: /`, the prototype
sits behind the same auth gate, and the exploration file holds illustrative figures only.

| # | Deliverable | File |
|---|---|---|
| 1 | Prototype directions | `prototypes/directions-1a-1b-1c.html`, `prototypes/signal-2a.html`, `prototypes/signal-mobile.html` |
| 2 | Token sheet | `tokens.md` |
| 3 | Interaction notes | `interactions.md` |
| 4 | Handoff note for the code pass | `handoff.md` |

## The prototypes

**`prototypes/signal-2a.html` — the chosen direction, now shipped.** A working page, not a
mockup: magic-link and passkey sign-in, live reads from the five `social_*` views, real
connect flow, idle logout. Single file, no build step. Signed out it shows the auth gate —
correct, since nothing is visible pre-auth. It needs `fonts/` alongside it, which the repo
has.

This file and the shipped `index.html` share a lineage, but the design copy now **leads `main`**: it adds the post-auth **launcher** (direction 1c), moves **Reads** into its own Aubrey North surface, and carries the Reads review features, the end-to-end gloss pass and the `.acct` accent fix. See `handoff.md` §0 for the full delta Cowork folds into `index.html`. Two review-only hooks live here and are dropped in production — `signalIdleWarn()` and `signalReadsDemo()` — deliberate, not drift.

**`prototypes/directions-1a-1b-1c.html` — the exploration.** The three earlier directions
side by side (1a Console, 1b Briefing, 1c Board) plus the token sheet rendered visually.
Self-contained; pan and zoom. Figures here are illustrative, modelled on the real data
shape — this file is the argument for 2a, not a live view. For anything real, use
`signal-2a.html`.

2a is **1c's scope rail plus 1b's briefing header**: the rail is navigation, the lede is
content, and merging them forces one rule — the summary follows the scope.

**`prototypes/signal-mobile.html` — the mobile-first build (new, for review).** Not the
desktop page collapsed: the scope rail becomes a bottom sheet, the write-actions (Connect,
Sync) move to a thumb-zone bar, the posts table becomes cards, and the availability matrix
transposes to one card per platform. Same tokens, same five `social_*` views, same
data-truth logic ported verbatim (briefing lede, `access_mode`, per-account availability,
gap-not-zero charts). Signed out it shows the auth gate. **Intended end state:** its
breakpoints fold into one responsive `index.html` — this separate file is for review, not a
second page to ship. That merge is the code pass's call.

## Reading order

`handoff.md` first — §4 records the three data-layer requests, all now shipped, and the one
grain change that would silently corrupt figures if code reads it stale. Then `tokens.md`
for what to bind to CSS custom properties, then `interactions.md` for states and URL
scheme. §5 of the handoff lists what is still open: the 200-row post cap, mobile beyond
grid collapse, chart re-instantiation per render, `innerHTML` concatenation, and arrow-key
roving focus in the profile menu.

Built against `cunningcorp/portal@a19cfbc3302c`, 18 Aug 2026. Read `handoff.md` §0 first for the launcher / Reads-surface / polish update; the rest of the package documents the 2a foundation it builds on.
