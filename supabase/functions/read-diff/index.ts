// read-diff -- read-only "what changed" for a queued Read versus the version live in
// cunningcorp/aubreynorth. Companion to publish-read, per PORTAL-READ-DIFF-SPEC.
//
//   POST /functions/v1/read-diff   { "id": "<reads_queue uuid>" }  or  { "slug": "..." }
//
// Why it exists: the portal labels a re-publish as an "Update" but cannot show WHAT
// changed, because the comparison needs the live file from GitHub and the browser has no
// token (correctly -- the token lives only in the edge functions). This closes that gap so
// "review edits" is a real review.
//
// Scope: strictly read-only. It never writes to the repo or the queue, never publishes,
// never edits copy (copylock). It is the input to the reviewer's decision; Publish stays
// the only verb.
//
// Auth: verify_jwt, identical to publish-read. Secret: reuses GITHUB_TOKEN (Contents read
// is enough here -- no write).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const REPO = "cunningcorp/aubreynorth";
const BRANCH = "main";

const CORS = {
  "Access-Control-Allow-Origin": "https://portal.cunningcorp.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Same frontmatter split publish-read uses, so the two functions agree on what a
// "body" and a "frontmatter block" are.
const FM = /^---\r?\n([\s\S]*?)\r?\n---/;

function splitDoc(markdown: string): { fm: string | null; body: string } {
  const m = FM.exec(markdown);
  if (!m) return { fm: null, body: markdown };
  return { fm: m[1], body: markdown.slice(m.index + m[0].length).replace(/^\s*\n/, "") };
}

/** Minimal YAML-ish field reader for the flat frontmatter these files use. */
function fmField(fm: string, name: string): string | null {
  const m = new RegExp(`^${name}:\\s*(.*)$`, "m").exec(fm);
  if (!m) return null;
  return m[1].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

/** tags: ["a","b"] or a flow/inline list -> string[]. Best-effort, display only. */
function fmTags(fm: string): string[] | null {
  const raw = fmField(fm, "tags");
  if (raw === null) return null;
  const inner = raw.replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner.split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

// Fields a human authored. draft and pubDate are excluded on purpose: publish-read
// rewrites both on every publish, so they always "change" and would be pure noise.
const AUTHORED = ["title", "description", "lane"];

function frontmatterChanges(liveFm: string, queuedFm: string) {
  const out: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const f of AUTHORED) {
    const a = fmField(liveFm, f), b = fmField(queuedFm, f);
    if (a !== b) out.push({ field: f, from: a, to: b });
  }
  const at = fmTags(liveFm), bt = fmTags(queuedFm);
  if (JSON.stringify(at) !== JSON.stringify(bt)) out.push({ field: "tags", from: at, to: bt });
  return out;
}

const normalise = (s: string) => s.replace(/[ \t]+$/gm, "").replace(/\n+$/, "\n").trim();

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const token = Deno.env.get("GITHUB_TOKEN");
  if (!token) return json({ error: "GITHUB_TOKEN secret is not set" }, 500);

  const payload = await req.json().catch(() => ({}));
  const { id, slug: slugIn } = payload as { id?: string; slug?: string };
  if (!id && !slugIn) return json({ error: "body must be { id } or { slug }" }, 400);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // --- Load the queue row ---------------------------------------------------
  let q = sb.from("reads_queue").select("slug, markdown");
  q = id ? q.eq("id", id) : q.eq("slug", slugIn!);
  const { data: row, error: loadErr } = await q.maybeSingle();
  if (loadErr) return json({ error: `load: ${loadErr.message}` }, 500);
  if (!row) return json({ error: "no such queue item" }, 404);

  const queued = splitDoc(row.markdown);
  if (queued.fm === null) return json({ error: "queued item has no frontmatter" }, 422);

  // --- Read the live file ---------------------------------------------------
  const api = `https://api.github.com/repos/${REPO}/contents/src/content/reads/${row.slug}.md`;
  const gh = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "signal-portal-read-diff",
  };

  const res = await fetch(`${api}?ref=${BRANCH}`, { headers: gh });
  if (res.status === 404) {
    // First publish: nothing live to compare. Not an error.
    return json({ exists: false, slug: row.slug });
  }
  if (!res.ok) {
    return json({ error: `GitHub read ${res.status}: ${(await res.text()).slice(0, 300)}` }, 502);
  }

  const meta = await res.json();
  // Contents API returns base64 with embedded newlines; strip them before decode.
  const liveMarkdown = new TextDecoder().decode(
    Uint8Array.from(atob((meta.content ?? "").replace(/\n/g, "")), (c) => c.charCodeAt(0)),
  );
  const live = splitDoc(liveMarkdown);

  return json({
    exists: true,
    slug: row.slug,
    live_commit_sha: meta.sha ?? null,
    live_body: live.body,
    queued_body: queued.body,
    identical: normalise(live.body) === normalise(queued.body),
    frontmatter_changes: live.fm ? frontmatterChanges(live.fm, queued.fm) : [],
  });
});
