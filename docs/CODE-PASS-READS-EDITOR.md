# Code pass — Reads Editor v2 (branch `feat/reads-editor`)

_Prepared 21 Aug 2026 by the Cowork data session. Owner: Demetri._
_Source specs: `aubreynorth/PORTAL-EDITOR-SPEC.md` (authoritative) and the design
package `READS-EDITOR-DESIGN.md` (Downloads/design). Read both before starting._

## What this pass is

The Reads Editor is built and staged on `feat/reads-editor`. The backend is deployed
and verified; the front-end is logic-verified but has **never run in a real browser**.
This pass is the browser loop: click-test everything, fix what's rough, decide the one
open UX question (§5), and only then merge. `main` auto-deploys to the live,
internet-facing portal — do not merge until the checklist in §4 passes.

## 1 · What is already done (do not rebuild)

**Deployed to Supabase (project `qeafetctmtnqonhwhhlw`) and live now, dormant until
the UI ships:**

- `reads_queue` extended: `body_markdown`, `suggestions jsonb`, `sources jsonb`,
  `sources_checked bool`, `updated_at` (+touch trigger), `notes`; status lifecycle is
  now `draft → in_review → ready → publishing → published | failed`.
  Migrations `20260821141545/142426/142622`, mirrored on this branch.
- Authenticated UPDATE on `reads_queue`, deliberately narrow and **verified**:
  column-scoped grant (content + status only; `commit_sha`/`published_at`/`error`
  physically un-writable by the client) and RLS `WITH CHECK` pinning client-set
  status to `draft|in_review|ready`. The client cannot forge a publish state.
  Publishing remains exclusively the `publish-read` edge function (service role).
- `suggest-fixes` edge function v2: Anthropic-backed line-level suggestions.
  Reads `VOICE-RULES.md` from `cunningcorp/aubreynorth@main` as the single voice
  source (no baked-in fallback, by design). `verify_jwt` on, CORS locked to
  `https://portal.cunningcorp.com`. Default model `claude-haiku-4-5-20251001`,
  overridable via `SUGGEST_MODEL` secret. Returns
  `{ suggestions: [{id, section, original, suggested, reason}] }`.
- `publish-read` v3: server-side enforcement of the six voice checks (description
  140–160, no exclamation marks, no hype words, 2–4 H2s, internal links
  root-relative / no claude.ai-anthropic-localhost links, all suggestions reviewed)
  plus the Business gate (`sources_checked = true` required for lane `business`).
  A payload that fails cannot be forced through regardless of UI state.

**In `index.html` on this branch (the part this pass tests):**

- Triage view: four status columns (Draft / In review / Ready / Published) with
  counts, lane filter chips (All / Screen / Type / Business), newest-first. Cards
  carry lane, title, target query, word count, date, and conditional flags
  ("N fix suggestions", "Sources unchecked").
- Editor view: header (← Queue · status chip · "Saved · just now" · Mark ready ·
  Publish, disabled until checks pass); frontmatter card (Title, Description with a
  live 140–160 counter that turns gold in range / terracotta out, Target query,
  Tags); body as contenteditable blocks holding markdown source (B / Link insert
  markdown; H2 toggles the focused block) with a live aubreynorth-styled preview
  panel; suggestion stepper (Original struck through / Suggested / reason ·
  Reject / Skip / Accept, accept applies the diff and saves); "Before publish"
  checks panel mirroring the server checks; Sources panel + "Sources checked"
  toggle (Business only); "✦ Suggest fixes for this paragraph" calling
  `suggest-fixes` with the focused block as `section`.
- Behaviour wired: opening a `draft` flips it to `in_review` (persisted); every
  blur saves (frontmatter fields, body blocks) and recombines
  frontmatter + `body_markdown` into the full `markdown` payload; Publish routes
  through the existing `publishRead()` (confirm modal → edge function → refresh).
- The pre-editor `readsHtml` queue view was removed. The launcher tile's
  "N ready / queue clear" copy keys on ready|publishing|failed.

**Verified without a browser:** all inline JS passes `node --check`; block
round-trip (body → blocks → body) is byte-stable; `recombine()` patches
title/description/lane/tags and preserves `pubDate`/`draft`; the checks logic
flags each violation class; the RLS policy behaves (allowed edit + ready, blocked
forged publish, blocked commit_sha write).

## 2 · Prerequisites before testing suggest-fixes

Two of these are Demetri's, not yours — check they're done, don't do them:

1. `VOICE-RULES.md` must be merged to `cunningcorp/aubreynorth@main` (it is on
   branch `feat/voice-rules-config`). suggest-fixes 502s with a clear message
   until it is — that error is by design.
2. `ANTHROPIC_API_KEY` must exist as a Supabase edge-function secret (Demetri
   sets it; never in the repo or client).
3. Everything else works with no further setup: sign in to the portal, open Reads.

## 3 · Known rough edges to fix in this pass

These are the parts I could not click-test; treat them as suspect until proven:

- **Selection formatting.** `applyFormat()` wraps the current selection via
  `insertAtSelection()`; the fallback when nothing is selected appends
  `**text**` at the block's end. Verify selection wrapping works in Safari and
  Chrome; make the no-selection case insert at the caret, not append.
- **The Link button uses `window.prompt`.** The portal previously ripped
  `window.prompt` out of the connect flow (rough edge 11); this reintroduces one.
  Replace with a small inline popover or the house modal, matching tokens.
- **Caret preservation.** Blur-saves re-render the checks/preview via
  `renderReadsSurface()`; typing then immediately clicking Publish/Mark ready may
  race the blur handler. Verify no lost keystrokes and no caret jumps; debounce or
  re-order if needed.
- **Paste behaviour** in contenteditable blocks is untested. Force plain-text
  paste (strip HTML) so pasted rich text can't smuggle markup around the
  markdown source.
- **Enter key in a block** currently grows the same block (newlines inside one
  block collapse on serialise, since blocks split on blank lines). Decide: Enter
  splits the block in two (better), or document single-block paragraphs.
- **Mobile**: triage should be usable at phone width (columns stack single-file);
  the editor is desktop-first by spec. Confirm it degrades gracefully rather than
  breaking; a real phone editor is out of scope.
- **Empty-queue states** for each column and the "queue unavailable" path.

## 4 · Merge checklist (all must pass before `main`)

- [ ] Sign in on desktop → Reads shows triage; lane chips filter; counts right.
- [ ] Open a draft → status flips to `in_review` in the DB (check the chip and a
      reload); edits to every frontmatter field persist across reload.
- [ ] Body: type in a block, blur → preview updates, `markdown` in the DB carries
      the change with frontmatter intact (spot-check the row).
- [ ] B / Link / H2 each produce correct markdown; preview renders them; no HTML
      leaks into the stored markdown.
- [ ] Suggestion stepper: Accept applies the exact diff to the body and removes
      the suggestion; Reject removes without applying; Skip cycles; count ticks
      down; publish check "All fix suggestions reviewed" goes green at zero.
- [ ] "Suggest fixes for this paragraph" returns suggestions for the focused
      block (needs §2 done); a clean paragraph returns "reads clean" toast.
- [ ] Business Read: Publish stays disabled until Sources checked is on; the
      server also rejects if forced (try via devtools once — expect 422).
- [ ] Publish a real (throwaway or genuine) Read end to end: confirm modal →
      committing state → lands in Published column → live on aubreynorth.com.
      **This is a real publish to the live site — use content Demetri approves.**
- [ ] An Update (re-publish) shows the What-changed behaviour still works from
      the old flow if present, and publish replaces the live file (sha handling).
- [ ] Idle logout, launcher, Signal surface, and mobile Signal all unaffected.
- [ ] `node --check` on the inline script still passes after your changes.

## 5 · The one open UX decision

The spec's locked decision 1 was "light rich-text that emits markdown", ideal
form being in-place WYSIWYG (TipTap/ProseMirror). The portal is single-file and
buildless, so that library route was rejected; the shipped compromise shows
markdown marks in the blocks with a live preview beside. Demetri has accepted
this **for now**. If you can achieve true in-place bold/link rendering *without
a build step and without a heavyweight CDN dependency* (e.g. a careful
contenteditable-with-decorations approach), propose it as a follow-up with a
cost estimate — do not fold it into this pass.

## 6 · Rules that do not bend

Carried from CLAUDE.md / the standing posture — a pass that violates one is wrong:

- `main` auto-deploys; Demetri is the deploy gate. Work stays on the branch until
  the §4 checklist passes and he approves the merge.
- Publish is the only path to the live site; nothing may auto-publish. The
  authenticated role must never gain INSERT/DELETE on `reads_queue` or the
  ability to set publish states (the RLS + column grants enforce this — do not
  loosen them to make a test pass).
- No secrets in the repo, client code, or chat. `ANTHROPIC_API_KEY` and
  `GITHUB_TOKEN` live only as edge-function secrets.
- Single file, no build step, CDN-only dependencies (existing: Chart.js,
  Supabase, marked + DOMPurify).
- Tokens only — no new hex, type sizes, or radii. The aubreynorth site values
  (paper/ink/rust) are allowed **only** inside `.anprev`, the preview panel.
- Copylock applies to the *voice rules*, not the editor: the editor legitimately
  edits copy now (that is its purpose), but suggestions are never auto-applied.
- `esc()` every interpolation into innerHTML (the file's existing convention).
- Stage explicit paths in git (`git add <file>`), never `git add -A` — a shared
  working tree has burned us before.

## 7 · Out of scope for this pass

The drafting engine (a separate Cowork scheduled task — spec lives at
`aubreynorth/DRAFTING-ENGINE-SETUP.md`), the email digest (no mail provider yet),
unpublish/rollback, multi-author roles, pagination of a very large queue, and the
WYSIWYG upgrade (§5 — proposal only).
