// probe -- read-only diagnostic. Calls every endpoint the collectors depend on and
// returns the RAW response shape, writing nothing to the database.
//
// This exists because the three collectors were written from API documentation, not
// from observed responses. Before trusting a parser, point this at a real connected
// account and compare what actually comes back with what the collector assumes.
//
//   GET /functions/v1/probe?platform=youtube
//   GET /functions/v1/probe?platform=instagram&account=<uuid>
//   GET /functions/v1/probe?platform=tiktok&full=1     (skip array trimming)
//
// Safety properties, deliberately:
//   * No writes. No upserts, no sync_runs rows, nothing.
//   * Tokens are never returned. Any token-ish field is masked on the way out.
//   * Arrays are trimmed to two elements so the response stays readable.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const META_V = Deno.env.get("META_API_VERSION") ?? "v25.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function db(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "social" }, auth: { persistSession: false } },
  );
}

const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);
const unix = (d: string) => Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 1000);

/** Mask anything that looks like a credential, wherever it appears. */
const SECRET_KEY = /(access_token|refresh_token|client_secret|token|secret|password)/i;
function redact(v: unknown): unknown {
  if (typeof v === "string") return v.length > 24 ? `${v.slice(0, 6)}…[${v.length} chars]` : v;
  return "[redacted]";
}

/** Trim arrays and mask secrets so the payload is readable at a glance. */
function shape(v: unknown, full: boolean, depth = 0): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    const keep = full ? v : v.slice(0, 2);
    const out: unknown[] = keep.map((x) => shape(x, full, depth + 1));
    if (!full && v.length > 2) out.push(`…and ${v.length - 2} more (${v.length} total)`);
    return out;
  }
  if (depth > 6) return "[deep]";
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? redact(val) : shape(val, full, depth + 1);
  }
  return out;
}

/** Top-level key list — the fastest way to spot a renamed field. */
function keysOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.length ? [`[array of ${v.length}]`, ...keysOf(v[0])] : ["[empty array]"];
  if (v && typeof v === "object") return Object.keys(v as object);
  return [typeof v];
}

type Call = { label: string; url: string; init?: RequestInit; note?: string };

async function run(calls: Call[], full: boolean) {
  const results = [];
  for (const c of calls) {
    const started = Date.now();
    try {
      const res = await fetch(c.url, c.init);
      const text = await res.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 800); }
      results.push({
        endpoint: c.label,
        note: c.note,
        status: res.status,
        ok: res.ok,
        ms: Date.now() - started,
        top_level_keys: keysOf(body),
        payload: shape(body, full),
      });
    } catch (e) {
      results.push({
        endpoint: c.label,
        note: c.note,
        status: 0,
        ok: false,
        ms: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

// ------------------------------------------------------------ token handling
async function googleToken(refresh: string) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`google token refresh ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j.access_token as string;
}

async function tiktokToken(refresh: string) {
  const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: Deno.env.get("TIKTOK_CLIENT_KEY") ?? "",
      client_secret: Deno.env.get("TIKTOK_CLIENT_SECRET") ?? "",
      grant_type: "refresh_token",
      refresh_token: refresh,
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`tiktok token refresh: ${j.error} ${j.error_description ?? ""}`);
  return j.access_token as string;
}

// --------------------------------------------------------------------- main
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const platform = (url.searchParams.get("platform") ?? "").toLowerCase();
  const accountId = url.searchParams.get("account");
  const full = url.searchParams.get("full") === "1";

  const valid = ["youtube", "instagram", "facebook", "tiktok"];
  if (!valid.includes(platform)) {
    return json({ error: `platform must be one of ${valid.join(", ")}` }, 400);
  }

  const sb = db();

  let q = sb.from("accounts").select("id, platform, external_id, handle, display_name")
            .eq("platform", platform).eq("is_active", true);
  if (accountId) q = q.eq("id", accountId);
  const { data: accounts, error: aErr } = await q.limit(1);
  if (aErr) return json({ error: `load account: ${aErr.message}` }, 500);
  if (!accounts?.length) {
    return json({ error: `no active ${platform} account found. Connect one from the portal first.` }, 404);
  }
  const acct = accounts[0];

  const { data: cred } = await sb.from("credentials").select("*").eq("account_id", acct.id).maybeSingle();
  if (!cred) return json({ error: "account exists but has no stored credentials" }, 404);

  try {
    let calls: Call[] = [];

    if (platform === "youtube") {
      const tok = await googleToken(cred.refresh_token);
      const auth = { headers: { Authorization: `Bearer ${tok}` } };
      const D = "https://www.googleapis.com/youtube/v3";
      calls = [
        { label: "channels (mine)", url: `${D}/channels?part=snippet,statistics,contentDetails&mine=true`, init: auth,
          note: "collector reads statistics.subscriberCount / viewCount / videoCount and contentDetails.relatedPlaylists.uploads" },
        { label: "analytics reports (day)",
          url: `https://youtubeanalytics.googleapis.com/v2/reports?${new URLSearchParams({
            ids: `channel==${acct.external_id}`, startDate: daysAgo(7), endDate: today(),
            metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments,shares",
            dimensions: "day", sort: "day" })}`, init: auth,
          note: "collector maps columnHeaders[].name to metric names; check none have been renamed or dropped" },
        { label: "playlistItems (uploads)", url: `${D}/playlistItems?part=contentDetails&maxResults=3&playlistId=UU${acct.external_id.slice(2)}`, init: auth,
          note: "uploads playlist id is the channel id with UC->UU; collector reads it from contentDetails instead" },
      ];
    }

    if (platform === "instagram") {
      const t = cred.access_token;
      const G = `https://graph.facebook.com/${META_V}`;
      const since = unix(daysAgo(14)), until = unix(today());
      calls = [
        { label: "ig profile", url: `${G}/${acct.external_id}?fields=username,name,profile_picture_url,followers_count,follows_count,media_count&access_token=${t}` },
        { label: "ig insights (timeseries)", url: `${G}/${acct.external_id}/insights?metric=reach,follower_count&period=day&since=${since}&until=${until}&access_token=${t}`,
          note: "collector folds values[].end_time into a date and values[].value into a number" },
        { label: "ig insights views (total_value)", url: `${G}/${acct.external_id}/insights?metric=views&metric_type=total_value&period=day&since=${since}&until=${until}&access_token=${t}`,
          note: "views replaced impressions across all versions from 21 Apr 2025 — confirm it returns" },
        { label: "ig media", url: `${G}/${acct.external_id}/media?fields=id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count&limit=3&access_token=${t}` },
      ];
    }

    if (platform === "facebook") {
      const t = cred.access_token;
      const G = `https://graph.facebook.com/${META_V}`;
      const since = unix(daysAgo(14)), until = unix(today());
      calls = [
        { label: "page fields", url: `${G}/${acct.external_id}?fields=name,username,link,followers_count,fan_count,picture.type(large)&access_token=${t}` },
        { label: "page insights", url: `${G}/${acct.external_id}/insights?metric=page_impressions_unique,page_post_engagements,page_video_views,page_fan_adds&period=day&since=${since}&until=${until}&access_token=${t}`,
          note: "Meta has retired many Page metrics; any that error here should come out of the collector's list" },
        { label: "page posts", url: `${G}/${acct.external_id}/posts?fields=id,message,permalink_url,created_time,full_picture,shares,likes.summary(true).limit(0),comments.summary(true).limit(0)&limit=3&access_token=${t}` },
      ];
    }

    if (platform === "tiktok") {
      const tok = await tiktokToken(cred.refresh_token);
      const auth = { Authorization: `Bearer ${tok}` };
      const A = "https://open.tiktokapis.com/v2";
      calls = [
        { label: "user/info", url: `${A}/user/info/?fields=open_id,union_id,avatar_url,display_name,bio_description,profile_deep_link,username,follower_count,following_count,likes_count,video_count`,
          init: { headers: auth },
          note: "collector reads data.user.*; a scope you were not granted silently drops its field" },
        { label: "video/list", url: `${A}/video/list/?fields=id,title,video_description,duration,cover_image_url,share_url,create_time,like_count,comment_count,share_count,view_count`,
          init: { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ max_count: 3 }) },
          note: "collector reads data.videos[]" },
      ];
    }

    const results = await run(calls, full);

    return json({
      probed_at: new Date().toISOString(),
      platform,
      account: { id: acct.id, external_id: acct.external_id, handle: acct.handle, display_name: acct.display_name },
      meta_api_version: platform === "instagram" || platform === "facebook" ? META_V : undefined,
      wrote_anything: false,
      summary: results.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.status} ${r.endpoint}`),
      results,
    });
  } catch (e) {
    return json({ platform, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
