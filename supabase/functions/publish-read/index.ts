// publish-read -- commits an approved Read from public.reads_queue to the
// cunningcorp/aubreynorth repo, which triggers the site's existing GitHub Pages
// deploy. Clicking Publish in the portal IS publishing; there is nothing else.
//
//   POST /functions/v1/publish-read   { "id": "<queue row uuid>" }
//
// Auth: verify_jwt -- the portal shares this project's auth, so a signed-in portal
// session is the credential. No shared key (spec open decision 1, settled).
//
// Secrets:
//   GITHUB_TOKEN  fine-grained PAT, cunningcorp/aubreynorth only, Contents read/write.
//                 Lives only here. Never in client code, never in a repo.
//
// Idempotency: rows move ready|failed -> publishing -> published|failed. The
// service-role-only write model is what makes this guard trustworthy -- the client
// cannot flip a status itself, so a double-click can't double-publish.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const REPO = "cunningcorp/aubreynorth";
const BRANCH = "main";
const SITE = "https://aubreynorth.com";

const CORS = {
  // Locked to the portal origin per the spec. Add localhost here only if a dev
  // loop genuinely needs it, and remove it after.
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

/** Today in Europe/London, YYYY-MM-DD -- the site's editorial timezone. */
function todayLondon(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" })
    .format(new Date());
}

/**
 * Rewrite the two frontmatter fields publishing controls: draft -> false and
 * pubDate -> the publish date. Everything else in the file is the approved copy
 * and is not touched -- the portal is not an editor (copylock rule).
 */
function rewriteFrontmatter(markdown: string): { out: string; error?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!m) return { out: markdown, error: "no frontmatter block found" };
  let fm = m[1];

  if (/^draft:/m.test(fm)) fm = fm.replace(/^draft:.*$/m, "draft: false");
  else fm += "\ndraft: false";

  const date = todayLondon();
  if (/^pubDate:/m.test(fm)) fm = fm.replace(/^pubDate:.*$/m, `pubDate: ${date}`);
  else fm += `\npubDate: ${date}`;

  return { out: markdown.slice(0, m.index) + `---\n${fm}\n---` + markdown.slice(m.index + m[0].length) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const token = Deno.env.get("GITHUB_TOKEN");
  if (!token) return json({ error: "GITHUB_TOKEN secret is not set -- see PORTAL-PUBLISH-SPEC" }, 500);

  const { id } = await req.json().catch(() => ({}));
  if (!id) return json({ error: "body must be { id: <queue row uuid> }" }, 400);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // --- Load and guard -------------------------------------------------------
  const { data: row, error: loadErr } = await sb
    .from("reads_queue").select("*").eq("id", id).maybeSingle();
  if (loadErr) return json({ error: `load: ${loadErr.message}` }, 500);
  if (!row) return json({ error: "no such queue item" }, 404);

  // ready -> publish, failed -> retry. Anything else is a no.
  if (!(["ready", "failed"].includes(row.status))) {
    return json({
      error: `item is '${row.status}', not publishable`,
      hint: row.status === "published" ? `already live: ${SITE}/reads/${row.slug}/` : "try again shortly",
    }, 409);
  }

  // Atomic claim: only wins if the status is still what we just read, so two
  // simultaneous clicks produce one publish and one 409.
  const { data: claimed } = await sb
    .from("reads_queue")
    .update({ status: "publishing", error: null })
    .eq("id", id).eq("status", row.status)
    .select("id");
  if (!claimed?.length) return json({ error: "another publish is already in flight" }, 409);

  const fail = async (msg: string, status = 422) => {
    await sb.from("reads_queue").update({ status: "failed", error: msg.slice(0, 1000) }).eq("id", id);
    return json({ error: msg }, status);
  };

  // --- Validate --------------------------------------------------------------
  if (!/^[a-z0-9-]+$/.test(row.slug)) return fail(`slug '${row.slug}' must be [a-z0-9-]+`);
  if (!(["screen", "type", "business"].includes(row.lane))) return fail(`lane '${row.lane}' invalid`);
  const dlen = (row.description ?? "").length;
  if (dlen < 140 || dlen > 160) return fail(`description is ${dlen} chars; must be 140-160`);

  const { out: finalMarkdown, error: fmErr } = rewriteFrontmatter(row.markdown);
  if (fmErr) return fail(fmErr);

  // --- Commit to GitHub ------------------------------------------------------
  const path = `src/content/reads/${row.slug}.md`;
  const api = `https://api.github.com/repos/${REPO}/contents/${path}`;
  const gh = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "signal-portal-publish-read",
  };

  // If the file exists (e.g. re-publish after an edit), its sha is required or
  // GitHub rejects the write as a conflict.
  let existingSha: string | undefined;
  const head = await fetch(`${api}?ref=${BRANCH}`, { headers: gh });
  if (head.ok) existingSha = (await head.json())?.sha;
  else if (head.status !== 404) {
    return fail(`GitHub read ${head.status}: ${(await head.text()).slice(0, 300)}`, 502);
  }

  const put = await fetch(api, {
    method: "PUT",
    headers: gh,
    body: JSON.stringify({
      message: `Publish Read: ${row.title}`,
      branch: BRANCH,
      content: btoa(String.fromCharCode(...new TextEncoder().encode(finalMarkdown))),
      ...(existingSha ? { sha: existingSha } : {}),
    }),
  });
  const putBody = await put.json().catch(() => ({}));
  if (!put.ok) {
    return fail(`GitHub write ${put.status}: ${JSON.stringify(putBody).slice(0, 300)}`, 502);
  }

  // --- Record ---------------------------------------------------------------
  const sha = putBody?.commit?.sha ?? null;
  await sb.from("reads_queue").update({
    status: "published",
    published_at: new Date().toISOString(),
    commit_sha: sha,
    markdown: finalMarkdown,   // store what actually shipped
    error: null,
  }).eq("id", id);

  return json({
    published: row.title,
    url: `${SITE}/reads/${row.slug}/`,
    commit: sha,
    note: "GitHub Pages deploys in about two minutes.",
  });
});
