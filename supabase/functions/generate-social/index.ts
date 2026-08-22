// generate-social -- generates the platform versions of a READY Read (X Article, X feed
// post, LinkedIn Newsletter, LinkedIn feed post, micro-posts) into the reads_queue.social
// jsonb pack, per PORTAL-SOCIAL-SPEC / design package doc 02. It NEVER posts anything: it
// writes copy for Demetri to review, Copy, and paste by hand. There is no platform API and
// no scheduler here.
//
//   POST /functions/v1/generate-social   { "id": "<reads_queue uuid>" }
//
// Guard: the Read must be status='ready' (generate from final copy only). Returns the pack
// and writes it to `social` with status='generated'. Posts nothing.
//
// Auth: verify_jwt (a signed-in portal session), same as suggest-fixes / publish-read.
// Voice + format are SINGLE-SOURCED from the aubreynorth repo -- the same VOICE-RULES.md
// suggest-fixes reads, plus DISTRIBUTION-STRATEGY.md for the per-channel format roles. The
// rules are never restated in this function body (that is the drift the single-source
// decision forbids); only the mechanical output shape + link discipline live here.
//
// Secrets:
//   ANTHROPIC_API_KEY  server-only; never in client code. Set by Demetri (shared with
//                      suggest-fixes -- setting it lights up both).
//   GITHUB_TOKEN       reused (Contents read) to fetch VOICE-RULES.md + DISTRIBUTION-STRATEGY.md.
// Model: env SOCIAL_MODEL; defaults to the same family as SUGGEST_MODEL below. Overridable so
//   the long-form (X Article / Newsletter) can be moved to a stronger model without a redeploy.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const REPO = "cunningcorp/aubreynorth";
const BRANCH = "main";
const SITE = "https://aubreynorth.com";
const VOICE_RULES_PATH = "VOICE-RULES.md";
const STRATEGY_PATH = "DISTRIBUTION-STRATEGY.md";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001"; // same family as SUGGEST_MODEL; override with SOCIAL_MODEL
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Platform limits -- single definition so a policy change is one edit. Mirrors the client
// panel's constants; the authoritative voice/link rules still come from the repo files.
const X_HOOK_LIMIT = 280;
const LI_POST_LIMIT = 3000;

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

// One in-memory cache per repo file for the life of the warm instance. Single source: on a
// fetch failure we throw rather than fall back to a baked-in copy (the drift the spec forbids).
const cache: Record<string, string> = {};
async function loadRepoFile(token: string, path: string): Promise<string> {
  if (cache[path]) return cache[path];
  const api = `https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`;
  const res = await fetch(api, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "signal-portal-generate-social",
    },
  });
  if (!res.ok) {
    throw new Error(
      `could not read ${path} from ${REPO}@${BRANCH} (${res.status}) -- ` +
        `it must be committed and pushed to ${BRANCH} before generate-social can read it`,
    );
  }
  const meta = await res.json();
  cache[path] = new TextDecoder().decode(
    Uint8Array.from(atob((meta.content ?? "").replace(/\n/g, "")), (c) => c.charCodeAt(0)),
  );
  return cache[path];
}

const SYSTEM_PREAMBLE =
  "You generate the social-platform versions of a finished Aubrey North Read. The Read has " +
  "already passed the copy gate, so it is on-voice by construction; your job is to adapt it " +
  "per platform WITHOUT going louder. Obey the two documents below exactly:\n" +
  " - VOICE-RULES.md is the authoritative voice + validation contract (no exclamation marks, " +
  "no hard-block hype words, restraint, resolution withheld in feed hooks).\n" +
  " - DISTRIBUTION-STRATEGY.md defines the per-channel format roles and the link discipline. " +
  "Follow its post anatomies for X and LinkedIn.\n\n" +
  "LINK DISCIPLINE (hard): the canonical link is provided as {{CANONICAL}}. Put it in the BODY " +
  "of x_article and li_longform, and in li_post.first_comment. NEVER put a link in a promotional-" +
  "post body (x_post.text, li_post.text). The x_post first line must be the Read's Mirror (opening) " +
  "line and must fit within " + X_HOOK_LIMIT + " characters as the hook. li_post.text must stay " +
  "under " + LI_POST_LIMIT + " characters.\n\n" +
  "HASHTAGS: populate each hashtags field from the hashtag policy in DISTRIBUTION-STRATEGY.md " +
  "(the X and LinkedIn post policies there). Put hashtags ONLY in the hashtags field, NEVER inside " +
  "a post body (x_post.text, li_post.text, micro text). li_longform is the long-form LinkedIn " +
  "asset (an Article now, a Newsletter issue once eligible).\n\n" +
  "OUTPUT: respond with ONLY one JSON object, no prose, no code fences, matching exactly:\n" +
  '{ "x_article": { "title": string, "body_markdown": string },' +
  ' "li_longform": { "title": string, "body_markdown": string },' +
  ' "x_post": { "text": string, "hashtags": string },' +
  ' "li_post": { "text": string, "first_comment": string, "hashtags": string },' +
  ' "micro_posts": [ { "text": string, "hashtags": string, "platforms": string[], "offset_days": number } ] }\n' +
  "Produce 4-6 micro_posts, one idea each, resolution withheld.\n\n";

/** Pull the first balanced JSON object out of the model's text, tolerating fences/prose. */
function parsePack(text: string): Record<string, unknown> | null {
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const obj = JSON.parse(t.slice(start, end + 1));
    return (obj && typeof obj === "object") ? obj as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
/** Strip any markdown/plain link to the canonical Read out of a promotional-post body. */
function stripLink(text: string, canonical: string): string {
  return text
    .replace(new RegExp(`\\[([^\\]]*)\\]\\(\\s*${canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\)`, "gi"), "$1")
    .replace(new RegExp(canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
/** Strip #hashtag tokens out of a promotional-post body — they belong in the hashtags field. */
function stripHashtags(text: string): string {
  return text
    .replace(/(^|[\s(])#[\p{L}0-9_]+/gu, "$1")
    .replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY secret is not set" }, 500);
  const ghToken = Deno.env.get("GITHUB_TOKEN");
  if (!ghToken) return json({ error: "GITHUB_TOKEN secret is not set" }, 500);

  const { id } = await req.json().catch(() => ({})) as { id?: string };
  if (!id) return json({ error: "body must be { id: <queue row uuid> }" }, 400);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: row, error: loadErr } = await sb
    .from("reads_queue")
    .select("title, description, slug, lane, tags, markdown, body_markdown, status, social")
    .eq("id", id).maybeSingle();
  if (loadErr) return json({ error: `load: ${loadErr.message}` }, 500);
  if (!row) return json({ error: "no such queue item" }, 404);

  // Guard: generate from FINAL copy only. Anything short of ready is rejected.
  if (row.status !== "ready" && row.status !== "publishing" && row.status !== "published") {
    return json({ error: `Read is '${row.status}', not ready -- mark it ready before generating social` }, 409);
  }
  if (!/^[a-z0-9-]+$/.test(row.slug ?? "")) return json({ error: `slug '${row.slug}' invalid` }, 422);

  const canonical = `${SITE}/reads/${row.slug}/`;
  const body = (row.body_markdown && row.body_markdown.trim()) ? row.body_markdown : bodyOf(row.markdown ?? "");
  if (!body.trim()) return json({ error: "Read has no body to adapt" }, 422);

  let voice: string, strategy: string;
  try {
    [voice, strategy] = await Promise.all([
      loadRepoFile(ghToken, VOICE_RULES_PATH),
      loadRepoFile(ghToken, STRATEGY_PATH),
    ]);
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 502);
  }

  const system = SYSTEM_PREAMBLE.replace(/\{\{CANONICAL\}\}/g, canonical) +
    "=== VOICE-RULES.md (authoritative voice) ===\n" + voice +
    "\n\n=== DISTRIBUTION-STRATEGY.md (format roles + link discipline) ===\n" + strategy;

  const userMsg =
    `Canonical link: ${canonical}\n` +
    `Lane: ${row.lane}\nTitle: ${row.title}\nDescription: ${row.description}\n` +
    `Tags: ${(Array.isArray(row.tags) ? row.tags : []).join(", ")}\n\n` +
    `--- Read body (final, markdown) ---\n${body}`;

  const model = Deno.env.get("SOCIAL_MODEL") ?? DEFAULT_MODEL;
  const anth = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 8000, system, messages: [{ role: "user", content: userMsg }] }),
  });
  if (!anth.ok) return json({ error: `Anthropic ${anth.status}: ${(await anth.text()).slice(0, 400)}` }, 502);

  const aBody = await anth.json().catch(() => ({}));
  const outText = (aBody?.content ?? []).filter((b: { type?: string }) => b.type === "text")
    .map((b: { text?: string }) => b.text ?? "").join("\n");
  const parsed = parsePack(outText);
  if (!parsed) return json({ error: "model did not return valid JSON", raw: outText.slice(0, 400) }, 502);

  // Normalise to the v3 pack shape + enforce link + hashtag discipline server-side (belt and
  // braces over the model): links stay in the long-form bodies + li_post.first_comment;
  // '#' is scrubbed out of every promotional-post body. Then stamp per-channel state.
  const xa = (parsed.x_article ?? {}) as Record<string, unknown>;
  // Tolerant read of the model's key: prefer li_longform, accept li_newsletter.
  const lin = (parsed.li_longform ?? parsed.li_newsletter ?? {}) as Record<string, unknown>;
  const lip = (parsed.li_post ?? {}) as Record<string, unknown>;
  const xp = (parsed.x_post ?? {}) as Record<string, unknown>;
  const ensureLink = (text: string) => text.includes(canonical) ? text : `${text.trim()}\n\n${canonical}`;
  const promo = (text: string) => stripHashtags(stripLink(text, canonical));   // no link, no '#'
  const micro = (Array.isArray(parsed.micro_posts) ? parsed.micro_posts : []).slice(0, 6)
    .map((m) => {
      const mm = (m ?? {}) as Record<string, unknown>;
      return {
        text: promo(str(mm.text)),
        hashtags: str(mm.hashtags),
        platforms: Array.isArray(mm.platforms) ? mm.platforms.map(String) : ["x", "linkedin"],
        offset_days: typeof mm.offset_days === "number" ? mm.offset_days : 2,
        state: "generated",
      };
    }).filter((m) => m.text);

  const pack = {
    status: "generated",
    generated_at: new Date().toISOString(),
    canonical,
    model,
    x_article: { title: str(xa.title), body_markdown: ensureLink(str(xa.body_markdown)), state: "generated" },
    li_longform: { title: str(lin.title), body_markdown: ensureLink(str(lin.body_markdown)), state: "generated" },
    x_post: { text: promo(str(xp.text)), hashtags: str(xp.hashtags), state: "generated" },
    li_post: { text: promo(str(lip.text)), first_comment: ensureLink(str(lip.first_comment)), hashtags: str(lip.hashtags), state: "generated" },
    micro_posts: micro,
  };

  const { error: saveErr } = await sb.from("reads_queue").update({ social: pack }).eq("id", id);
  if (saveErr) return json({ error: `save: ${saveErr.message}` }, 500);

  return json({ social: pack });
});
