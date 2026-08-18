# Design brief — polish pass on the Reads section

The Reads publishing queue is live in the portal: functionally complete, visually
first-draft. It was built by the data session to satisfy `docs/PORTAL-PUBLISH-SPEC.md`
using the existing component vocabulary — correct, but designed by nobody. Your job is
to make it feel like a deliberate part of Signal rather than a feature bolted on the
side. The backend is proven in production (two real articles published through it) and
is out of scope entirely.

Read first: `DESIGN-BRIEF.md` at the repo root (the git workflow section and the two
hard rules apply verbatim here — branch `design/reads-polish`, tokens only, no invented
data), then `docs/PORTAL-PUBLISH-SPEC.md` for what this feature is contractually, then
the live thing itself: portal.cunningcorp.com → Reads in the rail.

---

## 1 · What exists — audit of the current implementation

**Placement.** A "Reads" node at the bottom of the desktop rail and the mobile Scope
sheet, styled as a scope although it is really a different *mode* — the one place in the
portal you act on the world rather than observe it. The node badge shows the count of
items waiting (ready + failed), `!` if the queue can't be read, nothing when empty.
URL-addressable as `?view=reads`.

**Queue panel.** One card per ready/publishing/failed item: title (Recoleta), lane chip
(plain bordered text — deliberately not the platform-pill treatment), meta line (target
query, word count, queued date), a native `<details>` "Preview" disclosure containing
the rendered markdown (marked + DOMPurify, `.mdprev` styles), and an actions row —
Publish (periwinkle primary) with a caption "Publishes to aubreynorth.com within ~2
minutes." Publishing state: disabled button + progress caption. Failed state: terracotta
error line + the button relabelled Retry.

**Confirm modal.** Reuses the portal's scrim/modal with focus trap. Copy warns that
taking an article down again is a git operation, not a button.

**Published panel.** Reverse-chronological rows: title as live link, date, short commit
SHA in monospace. Empty states: "Nothing waiting." / "Nothing published from the queue
yet."

**Data contract for this view** (all of it — do not design for more): each queue row has
title, slug, lane (screen|type|business), description, tags[], full markdown, target
query, word count, status (ready|publishing|published|failed), created_at, published_at,
commit SHA, error text. Status changes only via the publish flow; the portal never
edits copy (copylock — this is a hard rule, not a v1 limitation).

## 2 · Known weaknesses — where the polish is needed

1. **The mode-vs-scope tension is unresolved.** Reads sits in the scope list but the
   scope bar, range switcher (7/30/90d), Sync now button and briefing strip above it are
   all analytics furniture that mean nothing here. Decide what the frame does in Reads
   mode rather than leaving the analytics chrome idling around a publishing queue.
2. **The preview is unstyled reading.** `.mdprev` is a minimal border-left block. This
   is Aubrey North editorial copy being reviewed before publication — it deserves
   something closer to how the article will actually read (the live site is the
   reference: aubreynorth.com/reads/…), without pretending to be a pixel preview.
3. **Publishing state is static.** The disabled button + caption is honest but inert for
   a ~2-minute background process. The periwinkle in-progress language used elsewhere
   (sync LED) could carry this.
4. **The published history is undesigned.** It will grow monotonically and is currently
   an unbounded list with no year/month rhythm.
5. **Mobile got the desktop panels unchanged.** They render fine in the mobile shell but
   nothing was considered: the confirm is a centre modal where every other mobile
   confirm is a bottom sheet; `<details>` disclosure targets are small; the actions row
   wraps awkwardly at narrow widths.
6. **Empty queue is a dead end.** "Nothing waiting." is correct in voice but the state
   could quietly say how something gets *into* the queue (drafted and approved in chat —
   see the pipeline in the spec) so future-Demetri isn't left wondering.

## 3 · Constraints

- Everything in root `DESIGN-BRIEF.md` §R6 and the two brand departures. The lane chip
  is currently neutral; if you give lanes colour, the division accents (Terracotta /
  Slate / Teal) are the only defensible mapping — and note Aubrey North's accent is
  Terracotta, which elsewhere means *negative*. Resolve that collision consciously or
  keep lanes neutral.
- One periwinkle glow per layout. Publish is the primary action of this view.
- Copy voice: Aubrey North adjacent — no exclamation marks, quiet, precise. Existing
  strings were written to that register; keep or improve, don't inflate.
- The security posture is untouchable: no editing affordances, no unpublish button
  (removing a live Read is deliberately a git operation), publish stays behind an
  explicit confirm.
- Functional behaviour is settled: optimistic status flip, re-read after every attempt,
  failed→Retry through the same path. Restyle it; don't rewire it.

## 4 · Deliverables

Same shape as the main brief: prototype the polished Reads view (desktop + mobile
states) against the live data — sign in and use the real queue; the Published list has
two real entries — plus interaction notes covering all six states (empty, ready,
publishing, published, failed, unreadable-queue) and a short handoff for the code pass
listing exactly which CSS/markup changes are wanted and what must not change. Commit to
`design/reads-polish`; you cannot push; tell Demetri what's waiting when you finish.
