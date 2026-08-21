// suggest-fixes -- live AI line-level fix suggestions for a Read, per
// PORTAL-EDITOR-SPEC Part 4. Powers the editor's "Suggest more" button and can be
// reused by the drafting engine for the pre-attached pass, so the voice rules live
// in ONE place: VOICE-RULES.md in cunningcorp/aubreynorth (decision 3).
//
//   POST /functions/v1/suggest-fixes
//     { "id": "<reads_queue uuid>" }              -- suggest over the row's body
//     { "id": "...", "section": "<paragraph>" }   -- suggest over one paragraph only
//     { "markdown": "..." }                        -- suggest over raw text (no row)
//
// Returns: { suggestions: [{ id, section, original, suggested, reason }] }
//
// It NEVER auto-applies and NEVER writes to the queue or the repo -- the portal
// renders the suggestions and the reviewer accepts/rejects each. Publish stays the
// only verb that changes the live site.
//
// Auth: verify_jwt (a signed-in portal session), same as publish-read / read-diff.
// Secrets:
//   ANTHROPIC_API_KEY  server-only; never in client code. Set by Demetri.
//   GITHUB_TOKEN       reused (Contents read) to fetch VOICE-RULES.md from the repo.
// Model: env SUGGEST_MODEL (a fast Claude model); defaults below. Overridable so the
//   exact model id can be set to whatever this Anthropic account has access to.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const REPO = "cunningcorp/aubreynorth";
const BRANCH = "main";
const VOICE_RULES_PATH = "VOICE-RULES.md";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";  // latest Haiku; override with SUGGEST_MODEL
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

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

const FM = /^---\r?\n([\s\S]*?)\r?\n---/;
function bodyOf(markdown: string): string {
  const m = FM.exec(markdown);
  return m ? markdown.slice(m.index + m[0].length).replace(/^\s*\n/, "") : markdown;
}

// In-memory cache of the rules for the life of the (warm) instance. Single source:
// if the fetch fails we do NOT fall back to a baked-in copy, because a second copy
// is exactly the drift the spec forbids.
let cachedRules: string | null = null;

async function loadVoiceRules(token: string): Promise<string> {
  if (cachedRules) return cachedRules;
  const api = `https://api.github.com/repos/${REPO}/contents/${VOICE_RULES_PATH}?ref=${BRANCH}`;
  const res = await fetch(api, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "signal-portal-suggest-fixes",
    },
  });
  if (!res.ok) {
    throw new Error(
      `could not read ${VOICE_RULES_PATH} from ${REPO}@${BRANCH} (${res.status}) -- ` +
        `merge the VOICE-RULES.md branch before using suggest-fixes`,
    );
  }
  const meta = await res.json();
  cachedRules = new TextDecoder().decode(
    Uint8Array.from(atob((meta.content ?? "").replace(/\n/g, "")), (c) => c.charCodeAt(0)),
  );
  return cachedRules;
}

const SYSTEM_PREAMBLE =
  "You are a line editor for Aubrey North Reads. Apply the voice and clarity rules " +
  "below to the text the user sends. Propose only concrete, line-level fixes -- never " +
  "rewrite the whole piece, never change the argument, never touch copy that already " +
  "obeys the rules. Each fix must quote the exact original span and its replacement, " +
  "and cite the rule it serves in a few words. Prefer clarity over cleverness. If the " +
  "text already reads well, return an empty array. Respond with ONLY a JSON array of " +
  '{ "section", "original", "suggested", "reason" } objects and no other text.\n\n' +
  "=== VOICE-RULES.md (authoritative) ===\n";

/** Pull the first JSON array out of the model's text, tolerating stray prose/fences. */
function parseSuggestions(text: string): Array<Record<string, string>> {
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY secret is not set" }, 500);
  const ghToken = Deno.env.get("GITHUB_TOKEN");
  if (!ghToken) return json({ error: "GITHUB_TOKEN secret is not set" }, 500);

  const payload = await req.json().catch(() => ({}));
  const { id, section, markdown } = payload as { id?: string; section?: string; markdown?: string };

  // Resolve the text to edit.
  let text = "";
  if (typeof section === "string" && section.trim()) {
    text = section;
  } else if (typeof markdown === "string" && markdown.trim()) {
    text = bodyOf(markdown);
  } else if (id) {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const { data: row, error } = await sb
      .from("reads_queue").select("markdown, body_markdown").eq("id", id).maybeSingle();
    if (error) return json({ error: `load: ${error.message}` }, 500);
    if (!row) return json({ error: "no such queue item" }, 404);
    text = (row.body_markdown && row.body_markdown.trim()) ? row.body_markdown : bodyOf(row.markdown ?? "");
  } else {
    return json({ error: "body must include { id } or { markdown } (optionally { section })" }, 400);
  }

  if (!text.trim()) return json({ suggestions: [] });

  let rules: string;
  try {
    rules = await loadVoiceRules(ghToken);
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 502);
  }

  const model = Deno.env.get("SUGGEST_MODEL") ?? DEFAULT_MODEL;
  const anth = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      system: SYSTEM_PREAMBLE + rules,
      messages: [{ role: "user", content: text }],
    }),
  });

  if (!anth.ok) {
    return json({ error: `Anthropic ${anth.status}: ${(await anth.text()).slice(0, 400)}` }, 502);
  }

  const body = await anth.json().catch(() => ({}));
  const out = (body?.content ?? []).filter((b: { type?: string }) => b.type === "text")
    .map((b: { text?: string }) => b.text ?? "").join("\n");

  const suggestions = parseSuggestions(out).map((s, i) => ({
    id: crypto.randomUUID(),
    section: String(s.section ?? "").slice(0, 400),
    original: String(s.original ?? "").slice(0, 2000),
    suggested: String(s.suggested ?? "").slice(0, 2000),
    reason: String(s.reason ?? "").slice(0, 300),
  })).filter((s) => s.original && s.suggested);

  return json({ suggestions, model });
});
