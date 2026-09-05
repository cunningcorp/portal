// list-prospects -- the DEDUPE READ for the headless daily prospecting task.
//
// HISTORY (4 Sep 2026): this began as an Apollo seed function. Then Demetri's own account
// proved that Apollo's `mixed_people/api_search` is PAID-ONLY on the Free plan ("not
// accessible even with a master key") -- Apollo's public docs claimed otherwise, the
// account is ground truth. So discovery moved to the task itself (web search + public UAE
// directories), and this function was repurposed to the one job the task still needs a
// server for: reading what is ALREADY in the queue, so a full ~15-minute dossier is never
// spent on a company we have already contacted or queued. Apollo stays only as the SEND
// channel (mailbox alias + sequences, enrolled by hand via Claude in Chrome).
//
//   POST /functions/v1/list-prospects
//     header  X-List-Secret: <LIST_PROSPECTS_SECRET>
//     body    {} , or { statuses?: string[], limit?: number }
//
//   -> { count, prospects: [ { source, source_ref, company, website, host, first_name,
//        full_name, status, created_at } ] }
//
// The task normalises `host` (website hostname, lowercased, no www) and `company` to skip
// candidates it already holds BEFORE spending DD. insert-prospect's unique index on
// (source, source_ref) is still the backstop at write time (409). This function WRITES
// NOTHING -- it reads outreach_queue via the service role and returns dedupe keys only (no
// dossier, no draft body, no email). verify_jwt = false: a headless task with no user
// session, gated on the constant-time shared-secret check. Recorded in config.toml.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** website -> bare lowercased host, no leading www. "" when unparseable. */
function hostOf(website: unknown): string {
  if (!str(website)) return "";
  try { return new URL(website).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const secret = Deno.env.get("LIST_PROSPECTS_SECRET");
  if (!secret) return json({ error: "LIST_PROSPECTS_SECRET is not set" }, 500);
  if (!safeEqual(req.headers.get("x-list-secret") ?? "", secret)) {
    return json({ error: "unauthorized" }, 401);
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const limit = Math.max(1, Math.min(Number(body.limit) || 1000, 5000));
  const statuses = Array.isArray(body.statuses)
    ? (body.statuses as unknown[]).filter(str) as string[]
    : null; // null = all statuses (dedupe against everything ever queued)

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  let q = sb
    .from("outreach_queue")
    .select("source, source_ref, company, website, first_name, full_name, status, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (statuses && statuses.length) q = q.in("status", statuses);

  const { data, error } = await q;
  if (error) return json({ error: `read: ${error.message}` }, 500);

  const prospects = (data ?? []).map((r) => ({
    source: r.source,
    source_ref: r.source_ref,
    company: r.company,
    website: r.website,
    host: hostOf(r.website),
    first_name: r.first_name,
    full_name: r.full_name,
    status: r.status,
    created_at: r.created_at,
  }));

  return json({ count: prospects.length, prospects });
});
