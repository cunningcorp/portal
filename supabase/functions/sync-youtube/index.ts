// sync-youtube -- channel totals, daily analytics and recent video metrics.
//
// Two access modes, chosen per channel by whether OAuth credentials exist:
//
//   OAUTH       Full access. Channel stats, 35 days of YouTube Analytics, and the
//               uploads playlist including unlisted videos. Requires the channel to
//               have granted consent.
//
//   PUBLIC-ONLY API key against public endpoints. Channel stats and public uploads,
//               but no Analytics -- daily views, watch time and subscribers gained
//               are private data and OAuth-only.
//
// Public-only exists because a Google account owns one channel directly and manages
// the rest as Brand Accounts, which are separate identities. channels.list?mine=true
// returns one channel per authentication, and a Brand Account cannot authorise an
// Internal app at all -- Google rejects it with 403 org_internal. An API key sidesteps
// identity entirely for the data that is public anyway.
//
// The mode is decided per channel and never downgrades: a channel with a refresh token
// always takes the OAuth path, so adding public-only channels cannot cost an existing
// channel its Analytics or its unlisted videos.
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (oauth) · YOUTUBE_API_KEY (public)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  Account, activeAccounts, chunk, credentialFor, daysAgo, db, fetchJson,
  finishRun, json, num, saveToken, startRun, today,
} from "./shared.ts";

const DATA_API = "https://www.googleapis.com/youtube/v3";
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2/reports";

// YouTube Analytics metric -> our metric name
const METRIC_MAP: Record<string, string> = {
  views: "views",
  estimatedMinutesWatched: "watch_time_minutes",
  averageViewDuration: "avg_view_duration_secs",
  subscribersGained: "followers_gained",
  subscribersLost: "followers_lost",
  likes: "likes",
  comments: "comments",
  shares: "shares",
};

async function accessToken(sb: any, account: Account, refresh: string) {
  const cred = await credentialFor(sb, account.id);
  const stillValid = cred?.access_token && cred.expires_at &&
    new Date(cred.expires_at).getTime() - Date.now() > 120_000;
  if (stillValid) return cred!.access_token!;

  const tok = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  await saveToken(sb, account.id, {
    access_token: tok.access_token,
    expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
  });
  return tok.access_token as string;
}

function parseIso8601Duration(d?: string): number | null {
  if (!d) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d);
  if (!m) return null;
  const [, days, h, min, s] = m;
  return (+(days ?? 0)) * 86400 + (+(h ?? 0)) * 3600 + (+(min ?? 0)) * 60 + (+(s ?? 0));
}

/** Channel snapshot + profile refresh. Identical either way; only auth differs. */
async function collectChannel(sb: any, account: Account, ch: any) {
  const st = ch.statistics ?? {};
  await sb.from("account_snapshots").upsert({
    account_id: account.id,
    captured_on: today(),
    // subscriberCount is the shortened public figure: exact below 1,000, then rounded
    // to three significant figures (1,234 -> 1230). hiddenSubscriberCount channels
    // report 0, so it is stored as null rather than a misleading zero.
    followers: st.hiddenSubscriberCount ? null : num(st.subscriberCount),
    total_views: num(st.viewCount),
    total_posts: num(st.videoCount),
    raw: st,
  }, { onConflict: "account_id,captured_on" });

  await sb.from("accounts").update({
    display_name: ch.snippet?.title ?? account.display_name,
    handle: ch.snippet?.customUrl ?? account.handle,
    avatar_url: ch.snippet?.thumbnails?.high?.url ?? null,
    profile_url: `https://www.youtube.com/channel/${account.external_id}`,
  }).eq("id", account.id);

  return 1;
}

/** Uploads playlist -> posts and post_metrics. auth is a header bag or empty for API key. */
async function collectVideos(sb: any, account: Account, uploads: string, suffix: string, auth: HeadersInit) {
  let rows = 0;
  const pl = await fetchJson(
    `${DATA_API}/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}${suffix}`,
    { headers: auth },
  );
  const ids: string[] = (pl.items ?? []).map((i: any) => i.contentDetails.videoId);

  for (const batch of chunk(ids, 50)) {
    if (!batch.length) continue;
    const vids = await fetchJson(
      `${DATA_API}/videos?part=snippet,statistics,contentDetails&id=${batch.join(",")}${suffix}`,
      { headers: auth },
    );
    for (const v of vids.items ?? []) {
      const dur = parseIso8601Duration(v.contentDetails?.duration);
      const { data: post } = await sb.from("posts").upsert({
        account_id: account.id,
        external_id: v.id,
        published_at: v.snippet?.publishedAt ?? null,
        post_type: dur !== null && dur <= 60 ? "short" : "video",
        title: v.snippet?.title ?? null,
        caption: (v.snippet?.description ?? "").slice(0, 2000),
        permalink: `https://www.youtube.com/watch?v=${v.id}`,
        thumbnail_url: v.snippet?.thumbnails?.medium?.url ?? null,
        duration_secs: dur,
      }, { onConflict: "account_id,external_id" }).select("id").single();
      if (!post) continue;

      const vs = v.statistics ?? {};
      await sb.from("post_metrics").upsert({
        post_id: post.id,
        captured_on: today(),
        views: num(vs.viewCount),
        likes: num(vs.likeCount),
        comments: num(vs.commentCount),
        raw: vs,
      }, { onConflict: "post_id,captured_on" });
      rows += 2;
    }
  }
  return rows;
}

// ------------------------------------------------------------------- OAUTH
async function syncOauth(sb: any, account: Account, refresh: string) {
  let rows = 0;
  const token = await accessToken(sb, account, refresh);
  const auth = { Authorization: `Bearer ${token}` };

  const chRes = await fetchJson(
    `${DATA_API}/channels?part=snippet,statistics,contentDetails&id=${account.external_id}`,
    { headers: auth },
  );
  const ch = chRes.items?.[0];
  if (!ch) throw new Error(`channel ${account.external_id} not visible to this token`);
  rows += await collectChannel(sb, account, ch);

  // Daily analytics, 35 days so late-arriving figures get corrected.
  const qs = new URLSearchParams({
    ids: `channel==${account.external_id}`,
    startDate: daysAgo(35),
    endDate: today(),
    metrics: Object.keys(METRIC_MAP).join(","),
    dimensions: "day",
    sort: "day",
  });
  try {
    const rep = await fetchJson(`${ANALYTICS_API}?${qs}`, { headers: auth });
    const cols: string[] = (rep.columnHeaders ?? []).map((c: any) => c.name);
    const dayIdx = cols.indexOf("day");
    const daily: any[] = [];
    for (const row of rep.rows ?? []) {
      cols.forEach((col, i) => {
        if (i === dayIdx) return;
        const name = METRIC_MAP[col];
        if (!name) return;
        daily.push({
          account_id: account.id,
          metric_date: row[dayIdx],
          metric: name,
          value: Number(row[i] ?? 0),
          updated_at: new Date().toISOString(),
        });
      });
    }
    for (const batch of chunk(daily, 500)) {
      await sb.from("daily_metrics").upsert(batch, { onConflict: "account_id,metric_date,metric" });
      rows += batch.length;
    }
  } catch (e) {
    // Needs yt-analytics.readonly and channel ownership. Public stats are already
    // saved, so degrade rather than fail the whole run.
    console.warn(`analytics skipped for ${account.external_id}: ${e}`);
  }

  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  if (uploads) rows += await collectVideos(sb, account, uploads, "", auth);
  return rows;
}

// ------------------------------------------------------------- PUBLIC ONLY
async function syncPublic(sb: any, account: Account, apiKey: string) {
  let rows = 0;
  const suffix = `&key=${apiKey}`;

  const chRes = await fetchJson(
    `${DATA_API}/channels?part=snippet,statistics,contentDetails&id=${account.external_id}${suffix}`,
  );
  const ch = chRes.items?.[0];
  if (!ch) throw new Error(`channel ${account.external_id} not found or not public`);
  rows += await collectChannel(sb, account, ch);

  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  if (uploads) rows += await collectVideos(sb, account, uploads, suffix, {});
  return rows;
}

// --------------------------------------------------------------------------
async function syncChannel(sb: any, account: Account, apiKey: string | undefined) {
  const runId = await startRun(sb, "youtube", account.id);
  let rows = 0;
  let mode = "unknown";
  try {
    const cred = await credentialFor(sb, account.id);
    if (cred?.refresh_token) {
      mode = "oauth";
      rows = await syncOauth(sb, account, cred.refresh_token);
    } else if (apiKey) {
      mode = "public";
      rows = await syncPublic(sb, account, apiKey);
    } else {
      await finishRun(sb, runId, "skipped", 0,
        "no OAuth credentials and YOUTUBE_API_KEY is not set");
      return { account: account.display_name ?? account.external_id, status: "skipped", mode: "none" };
    }
    await finishRun(sb, runId, "ok", rows,
      mode === "public" ? "public data only; no Analytics without OAuth" : undefined);
    return { account: account.display_name ?? account.external_id, status: "ok", mode, rows };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun(sb, runId, "error", rows, msg);
    return { account: account.display_name ?? account.external_id, status: "error", mode, error: msg };
  }
}

Deno.serve(async (_req: Request) => {
  const sb = db();
  try {
    const accounts = await activeAccounts(sb, "youtube");
    if (!accounts.length) return json({ platform: "youtube", results: [], note: "no active youtube accounts" });
    const apiKey = Deno.env.get("YOUTUBE_API_KEY");
    const results = [];
    for (const a of accounts) results.push(await syncChannel(sb, a, apiKey));
    return json({ platform: "youtube", results });
  } catch (e) {
    return json({ platform: "youtube", error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
