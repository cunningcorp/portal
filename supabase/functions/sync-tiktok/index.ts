// sync-tiktok -- creator profile stats and recent video metrics via the TikTok
// Display API v2.
//
// Account rows: platform='tiktok', external_id = open_id
// Credentials:  refresh_token from the TikTok OAuth flow
// Required secrets: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
// Required scopes:  user.info.basic, user.info.profile, user.info.stats, video.list
//
// TikTok's Display API exposes cumulative totals only -- there is no per-day
// timeseries endpoint outside the paid Business API. Daily movement is therefore
// derived here by differencing consecutive snapshots, which is why the sync must
// run at least once a day to keep the curve honest.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  Account, activeAccounts, credentialFor, db, fetchJson,
  finishRun, json, num, saveToken, startRun, today,
} from "./shared.ts";

const API = "https://open.tiktokapis.com/v2";

const USER_FIELDS = [
  "open_id", "union_id", "avatar_url", "display_name", "bio_description",
  "profile_deep_link", "username", "follower_count", "following_count",
  "likes_count", "video_count",
].join(",");

const VIDEO_FIELDS = [
  "id", "title", "video_description", "duration", "cover_image_url",
  "share_url", "create_time", "like_count", "comment_count",
  "share_count", "view_count",
].join(",");

async function accessToken(sb: any, account: Account) {
  const cred = await credentialFor(sb, account.id);
  if (!cred?.refresh_token) throw new Error("no refresh_token stored for this account");

  const stillValid = cred.access_token && cred.expires_at &&
    new Date(cred.expires_at).getTime() - Date.now() > 120_000;
  if (stillValid) return cred.access_token!;

  const tok = await fetchJson(`${API}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: Deno.env.get("TIKTOK_CLIENT_KEY") ?? "",
      client_secret: Deno.env.get("TIKTOK_CLIENT_SECRET") ?? "",
      grant_type: "refresh_token",
      refresh_token: cred.refresh_token,
    }),
  });
  if (tok.error) throw new Error(`token refresh: ${tok.error} ${tok.error_description ?? ""}`);

  await saveToken(sb, account.id, {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? cred.refresh_token,
    expires_at: new Date(Date.now() + (tok.expires_in ?? 86400) * 1000).toISOString(),
  });
  return tok.access_token as string;
}

/** Derive yesterday-to-today movement from the two most recent snapshots. */
async function deriveDaily(sb: any, accountId: string) {
  const { data } = await sb
    .from("account_snapshots")
    .select("captured_on, followers, total_views, total_likes, total_posts")
    .eq("account_id", accountId)
    .order("captured_on", { ascending: false })
    .limit(2);
  if (!data || data.length < 2) return 0;

  const [curr, prev] = data;
  const rows = [
    ["followers_gained", (curr.followers ?? 0) - (prev.followers ?? 0)],
    ["views", (curr.total_views ?? 0) - (prev.total_views ?? 0)],
    ["likes", (curr.total_likes ?? 0) - (prev.total_likes ?? 0)],
  ]
    .filter(([, v]) => Number.isFinite(v as number))
    .map(([metric, value]) => ({
      account_id: accountId,
      metric_date: curr.captured_on,
      metric,
      value: value as number,
      updated_at: new Date().toISOString(),
    }));

  if (!rows.length) return 0;
  await sb.from("daily_metrics").upsert(rows, { onConflict: "account_id,metric_date,metric" });
  return rows.length;
}

async function syncCreator(sb: any, account: Account) {
  const runId = await startRun(sb, "tiktok", account.id);
  let rows = 0;
  try {
    const token = await accessToken(sb, account);
    const auth = { Authorization: `Bearer ${token}` };

    // --- Profile ------------------------------------------------------------
    const info = await fetchJson(`${API}/user/info/?fields=${USER_FIELDS}`, { headers: auth });
    if (info.error?.code && info.error.code !== "ok") {
      throw new Error(`user/info: ${info.error.code} ${info.error.message ?? ""}`);
    }
    const u = info.data?.user ?? {};

    await sb.from("account_snapshots").upsert({
      account_id: account.id,
      captured_on: today(),
      followers: num(u.follower_count),
      following: num(u.following_count),
      total_likes: num(u.likes_count),
      total_posts: num(u.video_count),
      raw: u,
    }, { onConflict: "account_id,captured_on" });
    rows++;

    await sb.from("accounts").update({
      handle: u.username ?? account.handle,
      display_name: u.display_name ?? account.display_name,
      avatar_url: u.avatar_url ?? null,
      profile_url: u.profile_deep_link ?? null,
    }).eq("id", account.id);

    // --- Recent videos ------------------------------------------------------
    const list = await fetchJson(`${API}/video/list/?fields=${VIDEO_FIELDS}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ max_count: 20 }),
    });

    let videoViews = 0;
    for (const v of list.data?.videos ?? []) {
      const { data: post } = await sb.from("posts").upsert({
        account_id: account.id,
        external_id: String(v.id),
        published_at: v.create_time ? new Date(v.create_time * 1000).toISOString() : null,
        post_type: "video",
        title: (v.title ?? "").slice(0, 200) || null,
        caption: (v.video_description ?? "").slice(0, 2000),
        permalink: v.share_url ?? null,
        thumbnail_url: v.cover_image_url ?? null,
        duration_secs: num(v.duration),
      }, { onConflict: "account_id,external_id" }).select("id").single();
      if (!post) continue;

      videoViews += Number(v.view_count ?? 0);
      await sb.from("post_metrics").upsert({
        post_id: post.id,
        captured_on: today(),
        views: num(v.view_count),
        likes: num(v.like_count),
        comments: num(v.comment_count),
        shares: num(v.share_count),
        raw: v,
      }, { onConflict: "post_id,captured_on" });
      rows += 2;
    }

    // TikTok publishes no lifetime view total on the profile, so fall back to the
    // sum across the most recent videos -- and only when nothing better is stored.
    if (videoViews > 0) {
      await sb.from("account_snapshots").update({ total_views: videoViews })
        .eq("account_id", account.id).eq("captured_on", today())
        .is("total_views", null);
    }

    rows += await deriveDaily(sb, account.id);
    await finishRun(sb, runId, "ok", rows);
    return { account: account.display_name ?? account.external_id, status: "ok", rows };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun(sb, runId, "error", rows, msg);
    return { account: account.display_name ?? account.external_id, status: "error", error: msg };
  }
}

Deno.serve(async (_req: Request) => {
  const sb = db();
  try {
    const accounts = await activeAccounts(sb, "tiktok");
    if (!accounts.length) return json({ platform: "tiktok", results: [], note: "no active tiktok accounts" });
    const results = [];
    for (const a of accounts) results.push(await syncCreator(sb, a));
    return json({ platform: "tiktok", results });
  } catch (e) {
    return json({ platform: "tiktok", error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
