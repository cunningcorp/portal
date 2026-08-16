// sync-youtube -- channel totals, recent video metrics, and daily analytics.
//
// Split by what the data actually is, not by how the channel was connected:
//
//   PUBLIC     Channel totals and uploads. Read with an API key against
//              channels.list?id= and videos.list?id=. No identity involved, so this
//              works for every channel including Brand Accounts.
//
//   ANALYTICS  Daily views, watch time, subscribers gained. Genuinely private, so it
//              needs OAuth from that specific channel. Skipped when absent.
//
// Why it is split this way. A Google account owns one channel directly and manages the
// rest as Brand Accounts, which are separate identities. channels.list?mine=true returns
// one channel per authentication, and a Brand Account cannot authorise an Internal app at
// all (403 org_internal). Using an API key for public data removes identity from the part
// that never needed it, and confines OAuth to the part that genuinely does.
//
// It also means the app no longer needs youtube.readonly, which is a *sensitive* scope
// requiring Google verification to publish. yt-analytics.readonly alone is non-sensitive,
// so the consent screen can go External without review -- which is the only way a Brand
// Account can ever grant Analytics access.
//
// If YOUTUBE_API_KEY is missing, channels holding a token fall back to reading public data
// over OAuth, so an unset key degrades rather than breaks.
//
// Secrets: YOUTUBE_API_KEY · GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (analytics only)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  Account, activeAccounts, chunk, credentialFor, daysAgo, db, fetchJson,
  finishRun, json, num, saveToken, startRun, today,
} from "./shared.ts";

const DATA_API = "https://www.googleapis.com/youtube/v3";
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2/reports";

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

// ------------------------------------------------------------------- PUBLIC
async function collectPublic(sb: any, account: Account, suffix: string, auth: HeadersInit) {
  let rows = 0;

  const chRes = await fetchJson(
    `${DATA_API}/channels?part=snippet,statistics,contentDetails&id=${account.external_id}${suffix}`,
    { headers: auth },
  );
  const ch = chRes.items?.[0];
  if (!ch) throw new Error(`channel ${account.external_id} not found or not public`);

  const st = ch.statistics ?? {};
  await sb.from("account_snapshots").upsert({
    account_id: account.id,
    captured_on: today(),
    // subscriberCount is the shortened public figure: exact below 1,000, then rounded to
    // three significant figures. Channels hiding the count report 0, so store null rather
    // than a misleading zero.
    followers: st.hiddenSubscriberCount ? null : num(st.subscriberCount),
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

  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return rows;

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

// ---------------------------------------------------------------- ANALYTICS
async function collectAnalytics(sb: any, account: Account, token: string) {
  const qs = new URLSearchParams({
    ids: `channel==${account.external_id}`,
    startDate: daysAgo(35),   // 35 days so late-arriving figures get corrected
    endDate: today(),
    metrics: Object.keys(METRIC_MAP).join(","),
    dimensions: "day",
    sort: "day",
  });
  const rep = await fetchJson(`${ANALYTICS_API}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

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

  let rows = 0;
  for (const batch of chunk(daily, 500)) {
    await sb.from("daily_metrics").upsert(batch, { onConflict: "account_id,metric_date,metric" });
    rows += batch.length;
  }
  return rows;
}

// --------------------------------------------------------------------------
async function syncChannel(sb: any, account: Account, apiKey: string | undefined) {
  const runId = await startRun(sb, "youtube", account.id);
  let rows = 0;
  const modes: string[] = [];
  try {
    const cred = await credentialFor(sb, account.id);
    const token = cred?.refresh_token ? await accessToken(sb, account, cred.refresh_token) : null;

    // Public data. API key preferred; fall back to the token so a missing key degrades.
    if (apiKey) {
      rows += await collectPublic(sb, account, `&key=${apiKey}`, {});
      modes.push("public:key");
    } else if (token) {
      rows += await collectPublic(sb, account, "", { Authorization: `Bearer ${token}` });
      modes.push("public:oauth");
    } else {
      await finishRun(sb, runId, "skipped", 0,
        "no YOUTUBE_API_KEY and no OAuth credentials");
      return { account: account.display_name ?? account.external_id, status: "skipped", mode: "none" };
    }

    // Private analytics, only where the channel has consented.
    if (token) {
      try {
        rows += await collectAnalytics(sb, account, token);
        modes.push("analytics");
      } catch (e) {
        // Needs yt-analytics.readonly and channel ownership. Public data is already
        // saved, so degrade rather than fail the run.
        console.warn(`analytics skipped for ${account.external_id}: ${e}`);
        modes.push("analytics:failed");
      }
    }

    const mode = modes.join("+");
    // Persist the access mode so the UI keys on a value, not a sentence (design
    // handoff §6 request 3). A standalone "analytics" component means the channel
    // has working YouTube Analytics; "public:key" alone (no token) never will.
    await sb.from("accounts").update({ access_mode: mode }).eq("id", account.id);
    await finishRun(sb, runId, "ok", rows,
      token ? undefined : "public data only; Analytics needs OAuth from this channel");
    return { account: account.display_name ?? account.external_id, status: "ok", mode, rows };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun(sb, runId, "error", rows, msg);
    return {
      account: account.display_name ?? account.external_id,
      status: "error", mode: modes.join("+") || "none", error: msg,
    };
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
