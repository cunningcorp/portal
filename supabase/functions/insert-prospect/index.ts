// insert-prospect -- the ONLY way the (headless) daily prospecting task writes a new
// prospect into public.outreach_queue. Twin of insert-draft: it exists so the scheduled
// task never holds the Supabase service-role key. The key lives ONLY here; the task
// authenticates with a lesser shared secret (PROSPECT_INSERT_SECRET -- deliberately a
// DIFFERENT secret from DRAFT_INSERT_SECRET, so one leaked secret opens one queue).
// Spec: Prospecting Engine/portal/INTEGRATION-ANALYSIS.md v1.1 §3.3 + DECISIONS.md.
//
//   POST /functions/v1/insert-prospect
//     header  X-Prospect-Secret: <PROSPECT_INSERT_SECRET>
//     body    <row>  |  [<row>, ...]          (the daily job batches)
//
//   row = { lane, source, source_ref?, full_name, first_name, title?, company, website,
//           sector?, prospect?, email?, email_status?, audit_case?, audit, dossier?,
//           confidence?, dd_complete?, hook?, subject, body, variant?, voice_check?, notes? }
//
// Inserts status='in_review' ONLY -- it can never approve or set a send state, so
// automation still can't send anything; Demetri's Approve in the portal and the enrol
// write-back (service role) are the only paths forward.
//
// Guards (validates that the fields EXIST and the spine holds -- never that the dossier is
// true; truth is the an-outreach-copy skill's job upstream):
//   * enums; first_name; website is an http(s) URL
//   * the locked spine, both lanes (D1): subject starts "Aubrey North —"; body opens
//     "Hi {first_name} —"; body carries the opt-out line
//   * HARD-BLOCK hype words in subject/body -> 422 (a row that can never legally send must
//     not enter the queue). Soft-warn words are recorded into voice_check.soft_warn, not refused.
//   * business + dd_complete=true  -> dossier.why_approach, dossier.hook,
//                                     dossier.surface_map.fracture, confidence
//     business + dd_complete=false -> dossier.thin_reason (a thin footprint may still reach
//                                     the queue for a human call, but never silently)
//     creator                      -> audit.five_second_read, audit.real_story_quote, audit.one_shift
//   * dedupe: the partial unique index on (source, source_ref) -> 409 "already queued"
//
// verify_jwt = false: the caller is a headless scheduled task with no user session, so access
// is gated on the constant-time shared-secret check below instead of a JWT. Third deliberate
// verify_jwt=false after oauth-callback and insert-draft -- flagged in config.toml.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const LANES = ["business", "creator"] as const;
const SOURCES = ["apollo", "youtube", "manual"] as const;
const HOOKS = ["coffee_chat", "teardown"] as const;
const VARIANTS = ["direct", "story_first"] as const;
const CASES = ["buried", "mislabelled", "sharp"] as const;
const EMAIL_STATUSES = ["unrevealed", "public", "manual", "verified", "catch_all", "unavailable"] as const;
const CONFIDENCES = ["high", "medium", "low"] as const;

// Voice rules, VOICE-RULES.md v1.1 §2 (aubreynorth repo). Two tiers: hard-block words make
// a row unsendable; soft-warn words are flagged, never blocked. These regexes MIRROR the
// mechanical list in VOICE-RULES.md and the portal's HYPE_BLOCK / HYPE_WARN in index.html --
// if VOICE-RULES changes its list, change all three together.
const HYPE_BLOCK = /\b(revolutionary|game[-\s]changing|game changer|unleash|supercharge|turbocharge|disrupt|disruptive|cutting[-\s]edge|next[-\s]level|world[-\s]class|effortless|mind[-\s]blowing|jaw[-\s]dropping|best[-\s]in[-\s]class|paradigm|synergy)\b/gi;
const HYPE_WARN  = /\b(unlock|elevate|empower|seamless|leverage|delve)\b/gi;

// The locked spine (outreach-voice-reference.md, DECISIONS D1).
const SUBJECT_PREFIX = /^Aubrey North\s+—\s+\S/;
const OPT_OUT = /If you(?:'|’)d rather not hear from me again, just say so and I(?:'|’)ll leave it there\./;

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
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneOf = <T extends readonly string[]>(v: unknown, list: T): v is T[number] =>
  typeof v === "string" && (list as readonly string[]).includes(v);
const isUrl = (v: unknown) => {
  if (!str(v)) return false;
  try { const u = new URL(v); return u.protocol === "http:" || u.protocol === "https:"; }
  catch { return false; }
};
const hits = (re: RegExp, text: string) =>
  [...new Set((text.match(re) ?? []).map((w) => w.toLowerCase()))];

type Outcome = { ok: true; row: Record<string, unknown> } | { ok: false; status: number; error: string };

/** Validate one incoming row and shape it for insert. Never sets a non-review status. */
function prepare(p: Record<string, unknown>): Outcome {
  const bad = (error: string): Outcome => ({ ok: false, status: 422, error });

  // --- enums + spine fields ------------------------------------------------------
  if (!oneOf(p.lane, LANES)) return bad(`lane must be one of ${LANES.join(", ")}`);
  if (!oneOf(p.source, SOURCES)) return bad(`source must be one of ${SOURCES.join(", ")}`);
  if (p.source_ref !== undefined && p.source_ref !== null && !str(p.source_ref)) return bad("source_ref must be a non-empty string or null");
  if (!str(p.full_name)) return bad("full_name required");
  if (!str(p.first_name)) return bad("first_name required");
  if (!str(p.company)) return bad("company required");
  if (!isUrl(p.website)) return bad("website must be an http(s) URL");
  if (!str(p.subject)) return bad("subject required");
  if (!str(p.body)) return bad("body required");
  const hook = p.hook ?? (p.lane === "creator" ? "teardown" : "coffee_chat");
  if (!oneOf(hook, HOOKS)) return bad(`hook must be one of ${HOOKS.join(", ")}`);
  const variant = p.variant ?? "direct";
  if (!oneOf(variant, VARIANTS)) return bad(`variant must be one of ${VARIANTS.join(", ")}`);
  if (p.audit_case !== undefined && p.audit_case !== null && !oneOf(p.audit_case, CASES)) return bad(`audit_case must be one of ${CASES.join(", ")}`);
  const email_status = p.email_status ?? (str(p.email) ? (p.lane === "creator" ? "public" : "verified") : "unrevealed");
  if (!oneOf(email_status, EMAIL_STATUSES)) return bad(`email_status must be one of ${EMAIL_STATUSES.join(", ")}`);
  if (p.email !== undefined && p.email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(p.email))) return bad("email is not a plausible address");
  if (p.confidence !== undefined && p.confidence !== null && !oneOf(p.confidence, CONFIDENCES)) return bad(`confidence must be one of ${CONFIDENCES.join(", ")}`);
  const dd_complete = p.dd_complete === true;   // anything else is false: a row that says nothing must not claim completion

  type J = Record<string, unknown>;
  const audit: J = obj(p.audit) ? p.audit : {};
  const dossier: J = obj(p.dossier) ? p.dossier : {};
  const prospect: J = obj(p.prospect) ? p.prospect : {};
  const incomingVoice: J = obj(p.voice_check) ? p.voice_check : {};

  // --- the locked spine (D1: both lanes) -------------------------------------------
  const subject = (p.subject as string).trim();
  const body = (p.body as string).replace(/\r\n/g, "\n").trim();
  const first = (p.first_name as string).trim();
  const firstLine = body.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  const salutationOk = firstLine === `Hi ${first} —` || firstLine === "Hi {{first_name}} —";
  if (!SUBJECT_PREFIX.test(subject)) return bad('subject must start "Aubrey North — " followed by the hook');
  if (!salutationOk) return bad(`body must open "Hi ${first} —" on its own line (DECISIONS D1)`);
  if (!OPT_OUT.test(body)) return bad("body must contain the opt-out line: If you'd rather not hear from me again, just say so and I'll leave it there.");

  // --- hype: hard-block refuses, soft-warn records -----------------------------------
  // The audit mechanism quotes the prospect's own words back to them ("Elevate your stay",
  // "world-class comfort"), so words INSIDE double quotes are theirs, not ours: they are
  // noted, never refused. Everything outside quotation marks is our copy and is scanned.
  const scan = `${subject}\n${body}`;
  const quoted = (scan.match(/["“][^"”\n]{1,200}["”]/g) ?? []).join(" ");
  const ours = scan.replace(/["“][^"”\n]{1,200}["”]/g, '""');
  const hard = hits(HYPE_BLOCK, ours);
  if (hard.length) return bad(`hard-block hype word(s) in our copy (outside quotation marks): ${hard.join(", ")} -- not sendable, fix upstream`);
  const soft = hits(HYPE_WARN, ours);
  const quotedHype = [...hits(HYPE_BLOCK, quoted), ...hits(HYPE_WARN, quoted)];

  // --- research completeness, by lane ------------------------------------------------
  if (p.lane === "business") {
    if (dd_complete) {
      const sm: J = obj(dossier.surface_map) ? dossier.surface_map : {};
      const missing = [
        !str(dossier.why_approach) && "dossier.why_approach",
        !str(dossier.hook) && "dossier.hook",
        !str(sm.fracture) && "dossier.surface_map.fracture",
        !oneOf(p.confidence, CONFIDENCES) && "confidence",
      ].filter(Boolean);
      if (missing.length) return bad(`business row with dd_complete=true is missing: ${missing.join(", ")}`);
    } else if (!str(dossier.thin_reason)) {
      return bad("business row with dd_complete=false must carry dossier.thin_reason (why the five reads could not be finished)");
    }
  } else {
    const missing = [
      !str(audit.five_second_read) && "audit.five_second_read",
      !str(audit.real_story_quote) && "audit.real_story_quote",
      !str(audit.one_shift) && "audit.one_shift",
    ].filter(Boolean);
    if (missing.length) return bad(`creator row is missing: ${missing.join(", ")}`);
  }

  const notes: unknown[] = Array.isArray(incomingVoice.notes) ? [...(incomingVoice.notes as unknown[])] : [];
  if (quotedHype.length) notes.push(`hype word(s) only inside the prospect's quoted words: ${quotedHype.join(", ")}`);
  const voice_check = {
    ...incomingVoice,
    spine_ok: true,
    hard_block: [] as string[],
    soft_warn: soft,
    notes,
    passed: incomingVoice.passed === false ? false : true,
    checked_by: "insert-prospect",
  };

  return {
    ok: true,
    row: {
      lane: p.lane, source: p.source, source_ref: str(p.source_ref) ? p.source_ref : null,
      full_name: (p.full_name as string).trim(), first_name: first,
      title: str(p.title) ? p.title : null, company: (p.company as string).trim(),
      website: p.website, sector: str(p.sector) ? p.sector : null, prospect,
      email: str(p.email) ? (p.email as string).trim().toLowerCase() : null, email_status,
      audit_case: str(p.audit_case) ? p.audit_case : null, audit, dossier,
      confidence: str(p.confidence) ? p.confidence : null, dd_complete,
      hook, subject, body, variant, voice_check,
      notes: str(p.notes) ? p.notes : null,
      status: "in_review",   // the only status this function can ever write
    },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const secret = Deno.env.get("PROSPECT_INSERT_SECRET");
  if (!secret) return json({ error: "PROSPECT_INSERT_SECRET is not set" }, 500);
  if (!safeEqual(req.headers.get("x-prospect-secret") ?? "", secret)) {
    return json({ error: "unauthorized" }, 401);
  }

  const payload = await req.json().catch(() => null);
  const items: unknown[] = Array.isArray(payload) ? payload : [payload];
  if (!items.length || items.length > 25) return json({ error: "send 1–25 rows" }, 422);
  if (!items.every(obj)) return json({ error: "each row must be an object" }, 422);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const results: Record<string, unknown>[] = [];
  for (const item of items as Record<string, unknown>[]) {
    const prep = prepare(item);
    const label = `${item.company ?? "?"} / ${item.full_name ?? "?"}`;
    if (!prep.ok) { results.push({ row: label, status: prep.status, error: prep.error }); continue; }

    const { data, error } = await sb.from("outreach_queue").insert(prep.row).select("id").single();
    if (error) {
      // 23505 = unique_violation on outreach_queue_source_idx -> already queued (any status).
      if (error.code === "23505") results.push({ row: label, status: 409, error: "already queued (source, source_ref)" });
      else results.push({ row: label, status: 500, error: `insert: ${error.message}` });
      continue;
    }
    results.push({ row: label, status: 201, inserted: data.id, lane: prep.row.lane,
                   soft_warn: (prep.row.voice_check as { soft_warn: string[] }).soft_warn });
  }

  const inserted = results.filter((r) => r.status === 201).length;
  // Single row: answer with its own status code. Batch: 201 if all landed, else 207.
  if (results.length === 1) return json(results[0], results[0].status as number);
  return json({ inserted, results }, inserted === results.length ? 201 : 207);
});
