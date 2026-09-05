// propose-voice-rules -- the WRITE path for the weekly learning pass (LEARNING-PASS-TASK.md,
// LEARNING-LOOP-SPEC Part 2). Twin of list-read-edits: that one reads the edits, this one
// turns the conclusions into a pull request against VOICE-RULES.md.
//
// It exists because a Cowork scheduled task has no git credentials and cannot write to a
// repo. The GitHub PAT lives ONLY here (same posture as publish-read); the task authenticates
// with the lesser LEARNING_PASS_SECRET, the same shared secret it already uses to read.
//
//   POST /functions/v1/propose-voice-rules
//     header  X-Learning-Secret: <LEARNING_PASS_SECRET>
//
//     { "action": "read" }
//       -> { path, sha, content }        current VOICE-RULES.md on main, so the pass edits
//                                        the true current file and never clobbers a change
//                                        made since its last run.
//
//     { "action": "propose", "branch": "learning-pass/2026-09-08",
//       "content": "<full new VOICE-RULES.md>", "pr_title": "...", "pr_body": "..." }
//       -> { branch, commit, pull_request_url }  or, if the PAT can't open PRs,
//          { branch, commit, pull_request_url: null, compare_url, note }
//
// GUARDRAILS (this function can write to the website repo, so they are deliberately tight):
//   * PATH IS HARD-LOCKED to VOICE-RULES.md. It cannot write any other file, ever.
//   * BASE IS main and is never written to. All commits go to a NEW branch; a branch equal
//     to the base is refused. The PR is the review gate -- "propose, never apply".
//   * Branch names must start with "learning-pass/" so this function can't touch feature
//     branches belonging to anyone else.
//   * The update sends the file's current sha, so GitHub rejects a stale overwrite.
//
// KNOWN DEPENDENCY: GITHUB_TOKEN is a fine-grained PAT scoped to cunningcorp/aubreynorth with
// Contents read/write (that is all publish-read needed). Creating a pull request additionally
// requires **Pull requests: write**. If that scope is missing, PR creation returns 403 -- so
// this function degrades gracefully: the branch and commit still land, and it hands back a
// compare_url that opens the PR in one click. Add the scope to remove the manual step.
//
// verify_jwt = false: the caller is a headless scheduled task with no user session, gated on
// the constant-time shared-secret check instead. Recorded in config.toml.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const REPO = "cunningcorp/aubreynorth";
const BASE = "main";
const PATH = "VOICE-RULES.md";           // hard-locked; do not parameterise
const BRANCH_PREFIX = "learning-pass/";

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

/** UTF-8 safe base64 (VOICE-RULES.md is full of em dashes and curly quotes). Chunked so a
 *  large file can't blow the argument limit on String.fromCharCode. */
function b64encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64decode(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const secret = Deno.env.get("LEARNING_PASS_SECRET");
  if (!secret) return json({ error: "LEARNING_PASS_SECRET is not set" }, 500);
  if (!safeEqual(req.headers.get("x-learning-secret") ?? "", secret)) {
    return json({ error: "unauthorized" }, 401);
  }

  const token = Deno.env.get("GITHUB_TOKEN");
  if (!token) return json({ error: "GITHUB_TOKEN secret is not set" }, 500);

  const gh = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "aubrey-north-learning-pass",
  };

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = str(body.action) ? body.action : "read";

  // ---------- READ: hand back the current VOICE-RULES.md from main ----------
  const contentsUrl = `https://api.github.com/repos/${REPO}/contents/${PATH}`;
  const readRes = await fetch(`${contentsUrl}?ref=${BASE}`, { headers: gh });
  if (!readRes.ok) {
    return json({ error: `GitHub read ${readRes.status}`, detail: (await readRes.text()).slice(0, 300) }, 502);
  }
  const file = await readRes.json() as { sha: string; content: string };

  if (action === "read") {
    return json({ path: PATH, base: BASE, sha: file.sha, content: b64decode(file.content) });
  }
  if (action !== "propose") return json({ error: 'action must be "read" or "propose"' }, 422);

  // ---------- PROPOSE: branch -> commit -> pull request ----------
  const branch = str(body.branch) ? (body.branch as string).trim() : "";
  const content = str(body.content) ? (body.content as string) : "";
  const prTitle = str(body.pr_title) ? (body.pr_title as string).trim() : "";
  const prBody = str(body.pr_body) ? (body.pr_body as string) : "";

  if (!branch.startsWith(BRANCH_PREFIX)) {
    return json({ error: `branch must start with "${BRANCH_PREFIX}"` }, 422);
  }
  if (branch === BASE) return json({ error: "refusing to write to the base branch" }, 422);
  if (!content) return json({ error: "content required (the full new VOICE-RULES.md)" }, 422);
  if (!prTitle) return json({ error: "pr_title required" }, 422);
  if (content === b64decode(file.content)) {
    return json({ error: "content is identical to main — nothing to propose" }, 422);
  }

  // 1. base sha
  const refRes = await fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/${BASE}`, { headers: gh });
  if (!refRes.ok) {
    return json({ error: `GitHub ref read ${refRes.status}`, detail: (await refRes.text()).slice(0, 300) }, 502);
  }
  const baseSha = ((await refRes.json()) as { object: { sha: string } }).object.sha;

  // 2. create the branch (tolerate "already exists" so a retry is safe)
  const mkRef = await fetch(`https://api.github.com/repos/${REPO}/git/refs`, {
    method: "POST",
    headers: gh,
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });
  if (!mkRef.ok && mkRef.status !== 422) {
    return json({ error: `GitHub branch create ${mkRef.status}`, detail: (await mkRef.text()).slice(0, 300) }, 502);
  }

  // 3. commit VOICE-RULES.md onto the branch (sha guards against a stale overwrite)
  const put = await fetch(contentsUrl, {
    method: "PUT",
    headers: gh,
    body: JSON.stringify({
      message: prTitle,
      content: b64encode(content),
      sha: file.sha,
      branch,
    }),
  });
  const putBody = await put.json().catch(() => ({}));
  if (!put.ok) {
    return json({ error: `GitHub write ${put.status}`, detail: JSON.stringify(putBody).slice(0, 300) }, 502);
  }
  const commit = (putBody as { commit?: { sha?: string } })?.commit?.sha ?? null;

  // 4. open the PR. Needs "Pull requests: write" on the PAT -- degrade gracefully if absent.
  const compareUrl = `https://github.com/${REPO}/compare/${BASE}...${branch}?expand=1`;
  const pr = await fetch(`https://api.github.com/repos/${REPO}/pulls`, {
    method: "POST",
    headers: gh,
    body: JSON.stringify({ title: prTitle, head: branch, base: BASE, body: prBody }),
  });
  if (!pr.ok) {
    const detail = (await pr.text()).slice(0, 300);
    return json({
      branch, commit, pull_request_url: null, compare_url: compareUrl,
      note: pr.status === 403 || pr.status === 404
        ? 'Branch and commit landed, but the PAT cannot open pull requests. Add "Pull requests: write" to the fine-grained token for cunningcorp/aubreynorth, or open the PR from compare_url.'
        : `PR create failed (${pr.status}) — open it from compare_url.`,
      detail,
    }, 200);
  }
  const prJson = await pr.json() as { html_url?: string; number?: number };
  return json({
    branch,
    commit,
    pull_request_url: prJson.html_url ?? compareUrl,
    number: prJson.number ?? null,
  });
});
