// sync-instagram -- Instagram professional accounts via the Instagram API with
// Instagram Login (host: graph.instagram.com).
//
// This is NOT the same product as sync-meta. That one reads Instagram through
// graph.facebook.com using a Page access token, which requires the account to be
// linked to a Facebook Page. Business Login for Instagram has no such requirement,
// uses different credentials (Instagram app ID/secret, not the Meta app ones),
// different scopes, and a different token lifecycle. Keeping them as separate
// functions is deliberate: they only look similar.
//
// Account rows: platform='instagram', external_id = Instagram professional account id
// Credentials:  access_token = long-lived Instagram User token (60 days),
//               extra.login = 'instagram_login' so sync-meta knows to leave it alone
// Required secrets: INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET
// Required scopes:  instagram_business_basic, instagram_business_manage_insights

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  Account, activeAccounts, credentialFor, daysAgo, db, fetchJson,
  finishRun, json, num, saveToken, startRun, today,
} from "./shared.ts";

const V = Deno.env.get("META_API_VERSION") ?? "v25.0";
const GRAPH = `https://graph.instagram.com/${V}`;
const ROOT = "https://graph.instagram.com";

const PROFILE_FIELDS = [
  "user_id", "username", "name", "account_type", "profile_picture_url",
  "followers_count", "follows_count", "media_count",
].join(",");

const MEDIA_FIELDS = [
  "id", "caption", "media_type", "media_product_type", "permalink",
  "thumbnail_url", "media_url", "timestamp", "like_count", "comments_count",
].join(",");

const unix = (d: string) => Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 1000);

async function tryFetch(url: string, label: string) {
  try {
    return await fetchJson(url);
  } catch (e) {
    // Meta retires metrics without warning. A single dead metric should cost us
    // that metric, not the whole run.
    console.warn(`[instagram] ${label}: ${e}`);
    return null;
  }
}

/**
 * Long-lived Instagram tokens last 60 days and are refreshed in place -- there is
 * no separate refresh_token. The token must be at least 24 hours old and still
 * valid to be refreshable, so a token left to expire cannot be recovered without
 * reconnecting. Refresh once inside 14 days of expiry.
 */
async function accessToken(sb: any, account: Account) {
  const cred = await credentialFor(sb, account.id);
  if (!cred?.access_token) throw new Error("no access_token stored -- reconnect this account");

  const expires = cred.expires_at ? new Date(cred.expires_at).getTime() : 0;
  const daysLeft = (expires - Date.now()) / 86_400_000;

  if (expires && daysLeft < 0) {
    throw new Error(
      `token expired ${Math.abs(Math.round(daysLeft))} days ago and cannot be refreshed -- reconnect this account`,
    );
  }

  if (expires && daysLeft < 14) {
    const refreshed = await tryFetch(
      `${ROOT}/refresh_access_token?grant_type=ig_refresh_token&access_token=${cred.access_token}`,
      "token refresh",
    );
    if (refreshed?.access_token) {
      await saveToken(sb, account.id, {
        access_token: refreshed.access_token,
        expires_at: new Date(Date.now() + (refreshed.expires_in ?? 5_184_000) * 1000).toISOString(),
      });
      return refreshed.access_token as string;
    }
    console.warn(`[instagram] refresh failed with ${Math.round(daysLeft)} days left; using existing token`);
  }

  return cred.access_token;
}

async function writeDaily(sb: any, rows: any[]) {
  if (!rows.length) return 0;
  await sb.from("daily_metrics").upsert(rows, { onConflict: "account_id,metric_date,metric" });
  return rows.length;
}

const dailyRow = (accountId: string, date: string, metric: string, value: number) => ({
  account_id: accountId,
  metric_date: date,
  metric,
  value,
  updated_at: new Date().toISOString(),
});

async function syncAccount(sb: any, account: Account) {
  const runId = await startRun(sb, "instagram", account.id);
  let rows = 0;
  try {
    const token = await accessToken(sb, account);
    const auth = `access_token=${token}`;

    // --- 1. Profile ---------------------------------------------------------
    const me = await fetchJson(`${GRAPH}/me?fields=${PROFILE_FIELDS}&${auth}`);

    await sb.from("account_snapshots").upsert({
      account_id: account.id,
      captured_on: today(),
      followers: num(me.followers_count),
      following: num(me.follows_count),
      total_posts: num(me.media_count),
      raw: me,
    }, { onConflict: "account_id,captured_on" });
    rows++;

    await sb.from("accounts").update({
      handle: me.username ?? account.handle,
      display_name: me.name ?? me.username ?? account.display_name,
      avatar_url: me.profile_picture_url ?? null,
      profile_url: me.username ? `https://instagram.com/${me.username}` : null,
    }).eq("id", account.id);

    const id = me.user_id ?? account.external_id;
    const since = unix(daysAgo(29));
    const until = unix(today());

    // --- 2. Time-series insights -------------------------------------------
    // `reach` is one of the few account metrics that still supports time_series.
    const ts = await tryFetch(
      `${GRAPH}/${id}/insights?metric=reach&period=day&metric_type=time_series&since=${since}&until=${until}&${auth}`,
      "reach time_series",
    );
    const tsRows: any[] = [];
    for (const m of ts?.data ?? []) {
      for (const v of m.values ?? []) {
        const day = (v.end_time ?? "").slice(0, 10);
        if (day && typeof v.value === "number") tsRows.push(dailyRow(account.id, day, m.name, v.value));
      }
    }
    rows += await writeDaily(sb, tsRows);

    // --- 3. total_value insights -------------------------------------------
    // Most account metrics are total_value only now. There is no per-day breakdown
    // available, so each is stored against today as a rolling 28-day figure.
    // Requested one at a time: a single unsupported metric in a combined request
    // fails the whole call with "An unknown error has occurred."
    const TOTALS: Record<string, string> = {
      views: "views_28d",
      accounts_engaged: "accounts_engaged_28d",
      total_interactions: "total_interactions_28d",
      likes: "likes_28d",
      comments: "comments_28d",
      shares: "shares_28d",
      saves: "saves_28d",
      replies: "replies_28d",
    };
    const totalRows: any[] = [];
    for (const [metric, stored] of Object.entries(TOTALS)) {
      const r = await tryFetch(
        `${GRAPH}/${id}/insights?metric=${metric}&metric_type=total_value&period=day&since=${since}&until=${until}&${auth}`,
        `${metric} total_value`,
      );
      const value = r?.data?.[0]?.total_value?.value;
      if (typeof value === "number") totalRows.push(dailyRow(account.id, today(), stored, value));
    }
    rows += await writeDaily(sb, totalRows);

    // --- 4. Follows and unfollows ------------------------------------------
    // Replaces the old follower_count metric, which no longer exists on this API.
    const fu = await tryFetch(
      `${GRAPH}/${id}/insights?metric=follows_and_unfollows&metric_type=total_value&breakdown=follow_type&period=day&since=${since}&until=${until}&${auth}`,
      "follows_and_unfollows",
    );
    const breakdown = fu?.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? [];
    const fuRows: any[] = [];
    for (const r of breakdown) {
      const kind = String(r.dimension_values?.[0] ?? "").toUpperCase();
      const value = Number(r.value ?? 0);
      if (kind === "FOLLOWER" || kind === "FOLLOWED") fuRows.push(dailyRow(account.id, today(), "followers_gained_28d", value));
      if (kind === "NON_FOLLOWER" || kind === "UNFOLLOWED") fuRows.push(dailyRow(account.id, today(), "followers_lost_28d", value));
    }
    rows += await writeDaily(sb, fuRows);

    // --- 5. Media and per-media insights ------------------------------------
    const media = await tryFetch(`${GRAPH}/${id}/media?fields=${MEDIA_FIELDS}&limit=40&${auth}`, "media list");

    for (const m of media?.data ?? []) {
      const productType = String(m.media_product_type ?? m.media_type ?? "").toUpperCase();

      const { data: post } = await sb.from("posts").upsert({
        account_id: account.id,
        external_id: m.id,
        published_at: m.timestamp ?? null,
        post_type: productType.toLowerCase() || null,
        caption: (m.caption ?? "").slice(0, 2000),
        title: (m.caption ?? "").split("\n")[0].slice(0, 200) || null,
        permalink: m.permalink ?? null,
        thumbnail_url: m.thumbnail_url ?? m.media_url ?? null,
      }, { onConflict: "account_id,external_id" }).select("id").single();
      if (!post) continue;

      const metrics = productType === "STORY"
        ? "views,reach,replies"
        : "views,reach,likes,comments,shares,saved,total_interactions";
      const ins = await tryFetch(`${GRAPH}/${m.id}/insights?metric=${metrics}&${auth}`, `media insights ${m.id}`);

      const bag: Record<string, number> = {};
      for (const row of ins?.data ?? []) {
        const v = row.values?.[0]?.value ?? row.total_value?.value;
        if (typeof v === "number") bag[row.name] = v;
      }

      await sb.from("post_metrics").upsert({
        post_id: post.id,
        captured_on: today(),
        views: bag.views ?? null,
        likes: bag.likes ?? num(m.like_count),
        comments: bag.comments ?? num(m.comments_count),
        shares: bag.shares ?? null,
        saves: bag.saved ?? null,
        raw: bag,
      }, { onConflict: "post_id,captured_on" });
      rows += 2;
    }

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
    const all = await activeAccounts(sb, "instagram");

    // Only accounts that authenticated through Business Login for Instagram.
    // Page-linked accounts belong to sync-meta and use a different host entirely.
    const { data: creds } = await sb
      .from("credentials")
      .select("account_id, extra")
      .in("account_id", all.map((a) => a.id));
    const mine = new Set(
      (creds ?? []).filter((c: any) => c.extra?.login === "instagram_login").map((c: any) => c.account_id),
    );
    const accounts = all.filter((a) => mine.has(a.id));

    if (!accounts.length) {
      return json({
        platform: "instagram",
        results: [],
        note: all.length
          ? "instagram accounts exist but none use Instagram Login; sync-meta handles those"
          : "no active instagram accounts",
      });
    }

    const results = [];
    for (const a of accounts) results.push(await syncAccount(sb, a));
    return json({ platform: "instagram", api_version: V, results });
  } catch (e) {
    return json({ platform: "instagram", error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
