# Spec — "What changed" diff for the Reads queue (`read-diff`)

_Design-side proposal for the code/Cowork pass to finalise. Companion to
`docs/PORTAL-PUBLISH-SPEC.md`. Owner to confirm: Demetri._

## Why this exists

The portal's Reads queue now labels a re-publish as an **Update** and says it "replaces
the live version" (see `Signal Portal.html`, Reads surface). What it cannot yet do is show
**what** changed, because the comparison needs the article as it is live in
`cunningcorp/aubreynorth` — and the portal has no GitHub token in the browser (correctly:
the token lives only in the `publish-read` edge function). This endpoint closes that gap so
"review edits" is a real review, not a leap of faith.

Scope: **read-only diff**. It never writes, never publishes, and never edits copy
(copylock). It is the input to the reviewer's decision; Publish stays the only verb.

## Contract

`POST /functions/v1/read-diff`  ·  body `{ "id": "<reads_queue row uuid>" }`
(accept `{ "slug": "…" }` as an alternative if handier.)

**Auth:** `verify_jwt`, identical to `publish-read` — a signed-in portal session is the
credential. No shared key. **CORS:** allow `https://portal.cunningcorp.com` only (copy the
`CORS` block from `publish-read`).

**Secrets:** reuse `GITHUB_TOKEN` (fine-grained PAT, `cunningcorp/aubreynorth`, Contents
read — read is enough here; no write). Same secret already provisioned for `publish-read`.

## Behaviour

1. Load the queue row (service role, as `publish-read` does). 404 if absent.
2. Read the live file from GitHub:
   `GET /repos/cunningcorp/aubreynorth/contents/src/content/reads/{slug}.md?ref=main`
   with the same `gh` headers `publish-read` uses.
   - **404 → not published yet.** Return `{ "exists": false }` — the portal shows "New —
     no live version to compare" and no diff. (This is the common case for a first publish.)
   - Non-2xx (not 404) → `{ "error": … }`, 502.
3. Decode the base64 `content` to the live markdown string.
4. Split both the live file and `row.markdown` into **frontmatter** and **body** using the
   same regex `publish-read` uses: `/^---\r?\n([\s\S]*?)\r?\n---/`.
5. Return both sides plus metadata (below). **Do the actual line diff in the portal** — it
   already loads text libraries and renders markdown, so the function stays thin and has no
   diff dependency. (Alternative, if the team prefers server-side: return precomputed
   `hunks` as `{op:"eq"|"add"|"del", line:"…"}[]`; pick one and delete the other.)

## Response (recommended: bodies + parsed frontmatter, portal diffs)

```json
{
  "exists": true,
  "slug": "the-core-read",
  "live_commit_sha": "…",              // from the contents response
  "live_body": "…markdown after frontmatter…",
  "queued_body": "…markdown after frontmatter…",
  "identical": false,                   // convenience: bodies equal after trailing-ws trim
  "frontmatter_changes": [              // meaningful field edits, draft/pubDate EXCLUDED
    { "field": "description", "from": "…", "to": "…" },
    { "field": "tags", "from": ["screen"], "to": ["screen","character"] }
  ]
}
```

Notes that make the diff honest:
- **Exclude `draft` and `pubDate` from `frontmatter_changes`.** `publish-read` rewrites both
  every publish, so they always "change" and would be noise. Diff only the fields a human
  edited: `title`, `description`, `lane`, `tags` (and any future authored field).
- Compare **bodies**, not whole files, for the same reason — the frontmatter delta is
  reported separately and precisely.
- `identical: true` when the body matches after normalising trailing whitespace/newline —
  lets the portal say "No copy changes; frontmatter only" or "Already up to date".

## Portal UI contract (what the design will render)

- On an **Update** card, a "What changed" disclosure (peer of the existing "Read before
  publishing" preview) calls `read-diff` lazily on open.
- `exists:false` → "New — nothing live to compare yet."
- `identical:true` with no `frontmatter_changes` → "Already matches what's live."
- Otherwise: a line-level body diff (adds in gold, deletions in terracotta struck-through,
  matching the product's up/down colour language) and, above it, the
  `frontmatter_changes` as "description changed", "tags changed", etc.
- Read-only throughout. No accept/reject, no inline edit. Publish is unchanged; this only
  informs it.

## Edge cases

- Slug with no live file (first publish) → `exists:false`; never an error.
- `row.markdown` missing a frontmatter block → surface as `{ "error": "queued item has no
  frontmatter" }`, 422 (mirrors `publish-read`'s own guard so the two agree).
- Large files: fine over the Contents API; no pagination needed for single articles.
- Rate limits: one fetch per open, lazy (only when the reviewer expands "What changed"), so
  volume is trivial.

## Acceptance criteria

- [ ] Signed-in portal session can call it; unauthenticated is rejected; CORS locked to the
      portal origin.
- [ ] `GITHUB_TOKEN` stays server-side only; nothing sensitive reaches the client.
- [ ] A published slug returns live + queued bodies and accurate `frontmatter_changes` with
      `draft`/`pubDate` excluded.
- [ ] An unpublished slug returns `exists:false`, not an error.
- [ ] The endpoint never writes to the repo or the queue (read-only).

## Out of scope

Writing, publishing, editing copy, three-way merges, or resolving conflicts — none of that.
This returns the two versions (and the field deltas); the human reads it and decides.
