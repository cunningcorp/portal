// sync-youtube -- pulls channel totals, daily analytics and recent video metrics
// into the social schema. One row per channel in social.accounts (platform='youtube'),
// with a Google OAuth refresh token in social.credentials.
//
// Required secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
// Required scopes:  youtube.readonly, yt-analytics.readonly

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  Account, chunk, credentialFor, daysAgo, db, fetchJson,
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

async function accessToken(sb: any, account: Account) {
  const cred = await credentialFor(sb, account.id);
  if (!cred?.refresh_token) throw new Error("no refresh_token stored for this channel");

  const stillValid = cred.access_token && cred.expires_at &&
    new Date(cred.expires_at).getTime() - Date.now() > 120_000;
  if (stillValid) return cred.access_token!;

  const body = new URLSearchParams({
    client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
    client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
    refresh_token: cred.refresh_token,
    grant_type: "refresh_token",
  });
  const tok = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  await saveToken(sb, account.id, {
    access_token: tok.access_token,
    expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
  });
  return tok.access_token as string;
}

async function syncChannel(sb: any, account: Account) {
  const runId = await startRun(sb, "youtube", account.id);
  let rows = 0;
  try {
    const token = await accessToken(sb, account);
    const auth = { Authorization: `Bearer ${token}` };

    // --- 1. Channel totals -------------------------------------------------
    const chRes = await fetchJson(
      `${DATA_API}/channels?part=snippet,statistics,contentDetails&id=${account.external_id}`,
      { headers: auth },
    );
    const ch = chRes.items?.[0];
    if (!ch) throw new Error(`channel ${account.external_id} not visible to this token`);

    const st = ch.statistics ?? {};
    await sb.from("account_snapshots").upsert({
      account_id: account.id,
      captured_on: today(),
      followers: num(st.subscriberCount),
      total_views: num(st.viewCount),
      total_posts: num(st.videoCount),
      raw: st,
    }, { onConflict: "account_id,captured_on" });
    rows++;

    await sb.from("accounts").update({
      display_name: ch.snippet?.title ?? account.display_name,
      handle: ch.snippet?.customUrl ?? account.handle,
      avatar_url: ch.snippet?.thumbnails?.high?.url ?? null,
      profile_url: `https://www.youtube.com/channel/${account.external_id}`,
    }).eq("id", account.id);

    // --- 2. Daily analytics (last 35 days, backfills late-arriving data) ----
    const metrics = Object.keys(METRIC_MAP).join(",");
    const qs = new URLSearchParams({
      ids: `channel==${account.external_id}`,
      startDate: daysAgo(35),
      endDate: today(),
      metrics,
      dimensions: "day",
      sort: "day",
    });
    try {
      const rep = await fetchJson(`${ANALYTICS_API}?${qs}`, { headers: auth });
      const cols: string[] = (rep.columnHeaders ?? []).map((c: any) => c.name);
      const dayIdx = cols.indexOf("day");
      const daily: any[] = [];
      for (const row of rep.rows ?? []) {
        const date = row[dayIdx];
        cols.forEach((col, i) => {
          if (i === dayIdx) return;
          const name = METRIC_MAP[col];
          if (!name) return;
          daily.push({
            account_id: account.id,
            metric_date: date,
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
      // Analytics API needs yt-analytics.readonly and channel ownership.
      // Public stats still saved above, so degrade rather than fail the run.
      console.warn(`analytics skipped for ${account.external_id}: ${e}`);
    }

    // --- 3. Recent uploads + per-video metrics -----------------------------
    const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
    if (uploads) {
      const pl = await fetchJson(
        `${DATA_API}/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}`,
        { headers: auth },
      );
      const ids: string[] = (pl.items ?? []).map((i: any) => i.contentDetails.videoId);
      for (const batch of chunk(ids, 50)) {
        if (!batch.length) continue;
        const vids = await fetchJson(
          `${DATA_API}/videos?part=snippet,statistics,contentDetails&id=${batch.join(",")}`,
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

          if (post) {
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
      }
    }

    await finishRun(sb, runId, "ok", rows);
    return { account: account.display_name ?? account.external_id, status: "ok", rows };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun(sb, runId, "error", rows, msg);
    return { account: account.display_name ?? account.external_id, status: "error", error: msg };
  }
}

function parseIso8601Duration(d?: string): number | null {
  if (!d) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d);
  if (!m) return null;
  const [, days, h, min, s] = m;
  return (+(days ?? 0)) * 86400 + (+(h ?? 0)) * 3600 + (+(min ?? 0)) * 60 + (+(s ?? 0));
}

Deno.serve(async (_req: Request) => {
  const sb = db();
  try {
    const { activeAccounts } = await import("./shared.ts");
    const accounts = await activeAccounts(sb, "youtube");
    if (!accounts.length) return json({ platform: "youtube", results: [], note: "no active youtube accounts" });
    const results = [];
    for (const a of accounts) results.push(await syncChannel(sb, a));
    return json({ platform: "youtube", results });
  } catch (e) {
    return json({ platform: "youtube", error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
