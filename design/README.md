# Design handoff — Signal portal

Point-in-time artifact from the design pass. Not a brief, not a spec to maintain — it
records what was designed, why, and what it needed from the data layer. Cite it; don't
fold it into `CLAUDE.md` or `DESIGN-BRIEF.md`.

| File | What it is |
|---|---|
| `signal-2a-handoff.md` | The written handoff: tokens, structural vs decorative, interaction contract, data-layer requests, open items |
| `signal-2a.html` | The comp. Open it — it runs. Single file, no build |

## Where this goes

**Branch `design/prototypes`, not `main`.** `main` auto-deploys to the live,
internet-facing portal, so promoting this comp to `index.html` is a deploy decision for
Demetri — not a file move. Design sessions have no push credentials by design.

`signal-2a.html` is a working page, not a mockup: magic-link and passkey sign-in, live
reads from the five `social_*` views, real connect flow. Signed out it shows the auth
gate, which is correct — nothing is visible pre-auth.

## State as of 2026-08-17

Built against `cunningcorp/portal@a31cfe3742cd`. All three data-layer requests in §6 have
shipped and the comp is rebuilt against them — including the `social_daily_totals` grain
change, which is the one place a stale reading would silently double-count.

Since the copy last pushed to `main`, this version adds: the idle-logout warning dialog
and designed signed-out gate state, the sign-in polish (autofill repaint, `or` rule,
passkey button), the profile menu housing "Add a passkey", and the `access_mode` rebuild.

## One correction for the brief

§R6 says "Recoleta is the only file currently in the repo". All five faces are now
committed under `fonts/` — `GlamourAbsolute-400`, `GlamourAbsoluteExtended-400`,
`Graphik-400`, `Graphik-600`, `Recoleta-300`. Worth a one-line edit next time the brief
is touched.
