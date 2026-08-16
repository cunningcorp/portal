# Design handoff — Signal portal

Point-in-time artifact from the design pass. Not a brief, not a spec to maintain — it
records what was designed, why, and what it needs from the data layer. Cite it; don't
fold it into `CLAUDE.md` or `DESIGN-BRIEF.md`.

| File | What it is |
|---|---|
| `signal-2a-handoff.md` | The written handoff: tokens, structural vs decorative, interaction contract, data-layer requests, open items |
| `signal-2a.html` | The comp. Open it — it runs. Single file, no build, drop-in for `index.html` |

`signal-2a.html` is a working page, not a mockup: magic-link gate, live reads from the
five `social_*` views, real connect flow. Signed out it shows the auth gate, which is
correct — nothing is visible pre-auth.

Start at §6 of the handoff. Three one-line view changes are requested there, and the
first (`account_id` on `social_daily_totals`) is the one blocking a requirement.

Design pass by Claude, 16 Aug 2026, against `cunningcorp/portal@8f74c3a2c816`.
