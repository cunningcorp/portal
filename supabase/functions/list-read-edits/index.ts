// list-read-edits -- the READ the weekly learning pass calls to pull recent edits.
//
// The learning pass (a headless scheduled Cowork/Claude task, LEARNING-LOOP-SPEC Part 2) has
// no user session, and read_edits is authenticated-SELECT only. So it reads through this
// function -- service-role read, gated on a constant-time shared secret, exactly like
// list-prospects. It WRITES NOTHING and returns only the edit records (the frozen AI draft,
// what shipped, the lightweight diff, and any suggestion outcomes) for the pass to cluster.
//
//   POST /functions/v1/list-read-edits
//     header  X-Learning-Secret: <LEARNING_PASS_SECRET>
//     body    {} , or { since_days?: number (default 8), lane?: 'screen'|'type'|'business',
//                        limit?: number (default 500, max 2000) }
//
//   -> { count, since, read_edits: [ { id, created_at, slug, lane, commit_sha,
//        original_markdown, final_markdown, diff, suggestions } ] }
//
// verify_jwt = false: a headless task with no user JWT, gated on the shared-secret check
// below instead. Recorded in config.toml -- the fifth deliberate verify_jwt=false after
// oauth-callback, insert-draft, insert-prospect and list-prospects.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

  const secret = Deno.env.get("LEARNING_PASS_SECRET");
  if (!secret) return json({ error: "LEARNING_PASS_SECRET is not set" }, 500);
  if (!safeEqual(req.headers.get("x-learning-secret") ?? "", secret)) {
    return json({ error: "unauthorized" }, 401);
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sinceDays = Math.max(1, Math.min(Number(body.since_days) || 8, 400));
  const limit = Math.max(1, Math.min(Number(body.limit) || 500, 2000));
  const lane = typeof body.lane === "string" && LANES.includes(body.lane) ? body.lane : null;
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  let q = sb
    .from("read_edits")
    .select("id, created_at, slug, lane, commit_sha, original_markdown, final_markdown, diff, suggestions")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (lane) q = q.eq("lane", lane);

  const { data, error } = await q;
  if (error) return json({ error: `read: ${error.message}` }, 500);

  return json({ count: (data ?? []).length, since, read_edits: data ?? [] });
});
