// sync-search -- the Aubrey North Search Signal collector (an-search-signal-SPEC, Phase 1).
// Pulls Google Search Console performance into Supabase on a daily cadence: site-wide, per
// query, and per page, PLUS the differentiator -- for each published Read, its standing for
// its own target_query and its page URL. GSC-only in Phase 1 (GA4 + PageSpeed come in P2).
//
//   POST /functions/v1/sync-search        -> trailing ~30 days (the daily run)
//   POST /functions/v1/sync-search {days:480}  -> one-off backfill (up to 16 months)
//
// Auth: verify_jwt=true, same as the sync-youtube family (a signed-in portal session or the
// service key on the cron). Writes via the service role; the search tables are read-only for
// the client (RLS: authenticated SELECT only).
//
// Secrets:
//   GOOGLE_SA_JSON   the Google service-account key JSON (whole blob). The SA email must be
//                    added as a user in Search Console (Restricted read is enough).
//   (config) GSC_PROPERTY  env; defaults to the domain property sc-domain:aubreynorth.com.
// It mints a short-lived JWT from the SA key and exchanges it for a read-only GSC token; the
// key never leaves the function. Degrades independently -- a per-Read tie-in failure does not
// fail the site pull -- and logs the run in social.sync_runs with platform='search'.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SITE = "https://aubreynorth.com";
const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const LAG_DAYS = 3;      // GSC data is ~2-3 days behind; end the window there
const TIE_WINDOW = 7;    // per-Read standing is a trailing-7-day aggregate (meaningful WoW)

// ---- service-account JWT -> access token (RS256 via Web Crypto) -------------
function pemToBuf(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
function b64url(data: string | Uint8Array | ArrayBuffer): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data)
    : data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
async function accessToken(saJson: string): Promise<string> {
  const sa = JSON.parse(saJson);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.` +
    b64url(JSON.stringify({ iss: sa.client_email, scope: GSC_SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const key = await crypto.subtle.importKey("pkcs8", pemToBuf(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`SA token exchange ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.access_token;
}

// ---- GSC Search Analytics ---------------------------------------------------
const iso = (d: Date) => d.toISOString().slice(0, 10);
function daysAgo(n: number): Date { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; }

async function gsc(token: string, property: string, body: Record<string, unknown>): Promise<any> {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  const res = await fetch(url, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GSC ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}
const num = (v: unknown) => (typeof v === "number" ? v : null);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok");
  const saJson = Deno.env.get("GOOGLE_SA_JSON");
  if (!saJson) return json({ error: "GOOGLE_SA_JSON secret is not set" }, 500);
  const property = Deno.env.get("GSC_PROPERTY") ?? "sc-domain:aubreynorth.com";
  const { days } = (await req.json().catch(() => ({}))) as { days?: number };
  const windowDays = Math.min(Math.max(Number(days) || 30, 1), 480);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // open a run record
  const { data: run } = await sb.schema("social").from("sync_runs")
    .insert({ platform: "search", started_at: new Date().toISOString(), status: "running" }).select("id").maybeSingle();
  const finish = async (status: string, rows: number, message: string) => {
    if (run?.id) await sb.schema("social").from("sync_runs")
      .update({ finished_at: new Date().toISOString(), status, rows_written: rows, message: message.slice(0, 800) }).eq("id", run.id);
  };

  const endDate = iso(daysAgo(LAG_DAYS));
  const startDate = iso(daysAgo(LAG_DAYS + windowDays));
  const errors: string[] = [];
  let written = 0;

  let token: string;
  try { token = await accessToken(saJson); }
  catch (e) { const m = String(e instanceof Error ? e.message : e); await finish("failed", 0, m); return json({ error: m }, 502); }

  // --- site/query/page passes → search_metrics_daily -------------------------
  const passes: Array<{ dimension: "overall" | "query" | "page"; dims: string[] }> = [
    { dimension: "overall", dims: ["date"] },
    { dimension: "query", dims: ["date", "query"] },
    { dimension: "page", dims: ["date", "page"] },
  ];
  for (const p of passes) {
    try {
      const data = await gsc(token, property, { startDate, endDate, dimensions: p.dims, rowLimit: 1000 });
      const rows = (data.rows ?? []).map((r: any) => {
        const keys = r.keys ?? [];
        return {
          property, metric_date: keys[0], dimension: p.dimension,
          dim_value: p.dimension === "overall" ? "" : String(keys[1] ?? ""),
          clicks: r.clicks ?? 0, impressions: r.impressions ?? 0, ctr: num(r.ctr), position: num(r.position), raw: r,
        };
      }).filter((r: any) => r.metric_date);
      if (rows.length) {
        const { error } = await sb.from("search_metrics_daily").upsert(rows, { onConflict: "property,metric_date,dimension,dim_value" });
        if (error) throw new Error(error.message);
        written += rows.length;
      }
    } catch (e) { errors.push(`${p.dimension}: ${e instanceof Error ? e.message : e}`); }
  }

  // --- per-Read tie-in → read_search (the differentiator) --------------------
  // Trailing-7-day standing for each published Read's page and its target_query.
  const tieEnd = endDate, tieStart = iso(daysAgo(LAG_DAYS + TIE_WINDOW));
  try {
    const { data: reads } = await sb.from("reads_queue")
      .select("id, slug, target_query").eq("status", "published").not("slug", "is", null);
    const captured_on = endDate;
    const snapshots: any[] = [];
    for (const rd of (reads ?? [])) {
      const pageUrl = `${SITE}/reads/${rd.slug}/`;
      const pageFilter = { filters: [{ dimension: "page", operator: "equals", expression: pageUrl }] };
      let pageRow: any = null, qRow: any = null;
      try {
        const pg = await gsc(token, property, { startDate: tieStart, endDate: tieEnd, dimensions: [], dimensionFilterGroups: [pageFilter], rowLimit: 1 });
        pageRow = (pg.rows ?? [])[0] ?? null;
      } catch (e) { errors.push(`tiein page ${rd.slug}: ${e instanceof Error ? e.message : e}`); }
      if (rd.target_query) {
        try {
          const qg = await gsc(token, property, {
            startDate: tieStart, endDate: tieEnd, dimensions: [],
            dimensionFilterGroups: [{ filters: [...pageFilter.filters, { dimension: "query", operator: "equals", expression: rd.target_query }] }],
            rowLimit: 1,
          });
          qRow = (qg.rows ?? [])[0] ?? null;   // null => not yet ranking for its target query
        } catch (e) { errors.push(`tiein query ${rd.slug}: ${e instanceof Error ? e.message : e}`); }
      }
      snapshots.push({
        read_id: rd.id, captured_on, target_query: rd.target_query ?? null,
        q_position: qRow ? num(qRow.position) : null, q_clicks: qRow ? (qRow.clicks ?? 0) : null,
        q_impressions: qRow ? (qRow.impressions ?? 0) : null, q_ctr: qRow ? num(qRow.ctr) : null,
        page_clicks: pageRow ? (pageRow.clicks ?? 0) : null, page_impressions: pageRow ? (pageRow.impressions ?? 0) : null,
        page_position: pageRow ? num(pageRow.position) : null,
        raw: { page: pageRow, query: qRow },
      });
    }
    if (snapshots.length) {
      const { error } = await sb.from("read_search").upsert(snapshots, { onConflict: "read_id,captured_on" });
      if (error) throw new Error(error.message);
      written += snapshots.length;
    }
  } catch (e) { errors.push(`tiein: ${e instanceof Error ? e.message : e}`); }

  const status = errors.length && written === 0 ? "failed" : (errors.length ? "partial" : "ok");
  await finish(status, written, errors.join(" | ") || `window ${startDate}..${endDate}`);
  return json({ status, rows_written: written, window: { startDate, endDate }, property, errors });
});
