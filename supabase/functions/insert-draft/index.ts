// insert-draft -- the ONLY way the (headless) drafting engine writes a new draft into
// public.reads_queue. It exists so the scheduled drafting task never has to hold the
// Supabase service-role key: the key lives ONLY here, and the task authenticates with a
// lesser shared secret (DRAFT_INSERT_SECRET). Mirrors the "service-role key lives only in
// edge functions" posture of publish-read. Answers DRAFTING-ENGINE-QUESTIONS Q2.
//
//   POST /functions/v1/insert-draft
//     header  X-Draft-Secret: <DRAFT_INSERT_SECRET>
//     body    { slug, title, lane, markdown,
//               description?, tags?, body_markdown?, target_query?, word_count?,
//               sources?, suggestions? }
//
// Inserts status='draft' only -- it can NEVER publish or set a publish state (publishing/
// published/failed), so automation still can't put anything live; Demetri's Publish click
// remains the only path to the site (PORTAL-EDITOR-SPEC guardrail).
//
// Guards: valid slug/lane; a Business draft must carry a non-empty sources list
// (VOICE-RULES.md safety gate); no duplicate slug (already queued OR already published to
// the live site).
//
// verify_jwt = false: the caller is a headless scheduled task with no user session, so
// access is gated on the constant-time shared-secret check below instead of a JWT. This is
// a deliberate deviation from the "all functions verify_jwt=true except oauth-callback"
// posture -- flagged in config.toml for Demetri's sign-off before deploy.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const REPO = "cunningcorp/aubreynorth";
const BRANCH = "main";
const LANES = ["screen", "type", "business"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Constant-time compare so the shared secret can't be recovered by timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const secret = Deno.env.get("DRAFT_INSERT_SECRET");
  if (!secret) return json({ error: "DRAFT_INSERT_SECRET is not set" }, 500);
  if (!safeEqual(req.headers.get("x-draft-secret") ?? "", secret)) {
    return json({ error: "unauthorized" }, 401);
  }

  const p = await req.json().catch(() => ({})) as Record<string, unknown>;
  const { slug, title, lane, markdown, description, body_markdown,
          target_query, word_count, tags, sources, suggestions } = p;

  // --- validate ---------------------------------------------------------------
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) return json({ error: "slug must be [a-z0-9-]+" }, 422);
  if (typeof title !== "string" || !title.trim()) return json({ error: "title required" }, 422);
  if (typeof lane !== "string" || !LANES.includes(lane)) return json({ error: `lane must be one of ${LANES.join(", ")}` }, 422);
  if (typeof markdown !== "string" || !markdown.trim()) return json({ error: "markdown required" }, 422);
  const srcArr = Array.isArray(sources) ? sources : [];
  // Business safety gate: a named-brand draft must arrive with verified sources.
  if (lane === "business" && srcArr.length === 0) {
    return json({ error: "business drafts must include a non-empty sources list" }, 422);
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // --- no duplicate slug: not already in the queue ----------------------------
  const { data: existing, error: exErr } = await sb
    .from("reads_queue").select("id, status").eq("slug", slug).maybeSingle();
  if (exErr) return json({ error: `lookup: ${exErr.message}` }, 500);
  if (existing) return json({ error: `slug already in the queue (status ${existing.status})` }, 409);

  // --- no duplicate slug: not already published to the live site --------------
  const ghToken = Deno.env.get("GITHUB_TOKEN");
  if (ghToken) {
    const head = await fetch(
      `https://api.github.com/repos/${REPO}/contents/src/content/reads/${slug}.md?ref=${BRANCH}`,
      { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "signal-portal-insert-draft" } },
    );
    if (head.ok) return json({ error: "slug already published on aubreynorth.com" }, 409);
  }

  // --- insert as a draft (never a publish state) ------------------------------
  const { data, error } = await sb.from("reads_queue").insert({
    slug, title, lane, markdown,
    // Freeze the AI draft as the learning-loop baseline (LEARNING-LOOP-SPEC Part 1). Written
    // once here; the editor cannot touch it (original_markdown is not in the authenticated
    // UPDATE column grant), so the original->final diff at publish is always honest.
    original_markdown: markdown,
    description: typeof description === "string" ? description : null,
    body_markdown: typeof body_markdown === "string" ? body_markdown : null,
    target_query: typeof target_query === "string" ? target_query : null,
    word_count: typeof word_count === "number" ? word_count : null,
    tags: Array.isArray(tags) ? tags : [],
    sources: srcArr,
    suggestions: Array.isArray(suggestions) ? suggestions : [],
    sources_checked: false,
    status: "draft",
  }).select("id").single();
  if (error) return json({ error: `insert: ${error.message}` }, 500);

  return json({ inserted: data.id, slug, lane, status: "draft" }, 201);
});
