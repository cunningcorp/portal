// sync-meta -- Facebook Pages, and Instagram accounts that are linked to a Page,
// via the Facebook Graph API (host: graph.facebook.com).
//
// Scope boundary with sync-instagram, which matters:
//   sync-meta       reads Instagram through a PAGE access token. Requires the
//                   Instagram account to be linked to a Facebook Page.
//   sync-instagram  reads Instagram through Business Login for Instagram on
//                   graph.instagram.com. No Page required.
// An Instagram account belongs to exactly one of them, decided by how it was
// connected and recorded in credentials.extra.login. This function skips any
// account marked 'instagram_login' so the two never fight over the same row.
//
// Account rows:
//   platform='facebook',  external_id = Page ID
//   platform='instagram', external_id = IG Business Account ID (Page-linked only)
// Optional secret: META_API_VERSION (defaults to v25.0)
//
// Note on metrics: Meta deprecated `impressions`, `plays` and `profile_views`
// across all versions from 21 Apr 2025. `views` is the replacement everywhere.
// Metric requests are individually fault-tolerant -- if Meta retires one, the
// rest of the sync still lands.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  Account, activeAccounts, credentialFor, daysAgo, db, fetchJson,
  finishRun, json, num, startRun, today,
} from "./shared.ts";

const V = Deno.env.get("META_API_VERSION") ?? "v25.0";
const GRAPH = `https://graph.facebook.com/${V}`;

async function tryFetch(url: string, label: string) {
  try {
    return await fetchJson(url);
  } catch (e) {
    console.warn(`[meta] ${label} failed: ${e}`);
    return null;
  }
}

const unix = (d: string) => Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 1000);

/** Fold a Graph insights timeseries response into daily_metrics rows. */
function foldTimeseries(accountId: string, payload: any, rename: Record<string, string> = {}) {
  const rows: any[] = [];
  for (const m of payload?.data ?? []) {
    const name = rename[m.name] ?? m.name;
    for (const v of m.values ?? []) {
      const day = (v.end_time ?? "").slice(0, 10);
      if (!day) continue;
      const val = typeof v.value === "object" ? null : Number(v.value ?? 0);
      if (val === null || !Number.isFinite(val)) continue;
      rows.push({
        account_id: accountId,
        metric_date: day,
        metric: name,
        value: val,
        updated_at: new Date().toISOString(),
      });
    }
  }
  return rows;
}

async function writeDaily(sb: any, rows: any[]) {
  if (!rows.length) return 0;
  await sb.from("daily_metrics").upsert(rows, { onConflict: "account_id,metric_date,metric" });
  return rows.length;
}

// ---------------------------------------------------------------- Instagram
async function syncInstagram(sb: any, account: Account, token: string) {
  let rows = 0;
  const id = account.external_id;

  const prof = await fetchJson(
    `${GRAPH}/${id}?fields=username,name,profile_picture_url,followers_count,follows_count,media_count&access_token=${token}`,
  );

  await sb.from("account_snapshots").upsert({
    account_id: account.id,
    captured_on: today(),
    followers: num(prof.followers_count),
    following: num(prof.follows_count),
    total_posts: num(prof.media_count),
    raw: prof,
  }, { onConflict: "account_id,captured_on" });
  rows++;

  await sb.from("accounts").update({
    handle: prof.username ?? account.handle,
    display_name: prof.name ?? prof.username ?? account.display_name,
    avatar_url: prof.profile_picture_url ?? null,
    profile_url: prof.username ? `https://instagram.com/${prof.username}` : null,
  }).eq("id", account.id);

  const since = unix(daysAgo(29));
  const until = unix(today());

  const ts = await tryFetch(
    `${GRAPH}/${id}/insights?metric=reach&period=day&since=${since}&until=${until}&access_token=${token}`,
    `ig timeseries ${id}`,
  );
  if (ts) rows += await writeDaily(sb, foldTimeseries(account.id, ts));

  for (const metric of ["views", "accounts_engaged", "total_interactions"]) {
    const tv = await tryFetch(
      `${GRAPH}/${id}/insights?metric=${metric}&metric_type=total_value&period=day&since=${since}&until=${until}&access_token=${token}`,
      `ig ${metric} ${id}`,
    );
    const total = tv?.data?.[0]?.total_value?.value;
    if (typeof total === "number") {
      rows += await writeDaily(sb, [{
        account_id: account.id,
        metric_date: today(),
        metric: `${metric}_28d`,
        value: total,
        updated_at: new Date().toISOString(),
      }]);
    }
  }

  const media = await tryFetch(
    `${GRAPH}/${id}/media?fields=id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count&limit=40&access_token=${token}`,
    `ig media ${id}`,
  );

  for (const m of media?.data ?? []) {
    const { data: post } = await sb.from("posts").upsert({
      account_id: account.id,
      external_id: m.id,
      published_at: m.timestamp ?? null,
      post_type: (m.media_product_type ?? m.media_type ?? "").toLowerCase() || null,
      caption: (m.caption ?? "").slice(0, 2000),
      title: (m.caption ?? "").split("\n")[0].slice(0, 200) || null,
      permalink: m.permalink ?? null,
      thumbnail_url: m.thumbnail_url ?? m.media_url ?? null,
    }, { onConflict: "account_id,external_id" }).select("id").single();
    if (!post) continue;

    const isStory = (m.media_product_type ?? "") === "STORY";
    const metrics = isStory
      ? "views,reach,replies"
      : "views,reach,likes,comments,shares,saved,total_interactions";
    const ins = await tryFetch(
      `${GRAPH}/${m.id}/insights?metric=${metrics}&access_token=${token}`,
      `ig media insights ${m.id}`,
    );
    const bag: Record<string, number> = {};
    for (const row of ins?.data ?? []) bag[row.name] = Number(row.values?.[0]?.value ?? 0);

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

  return rows;
}

// ----------------------------------------------------------------- Facebook
async function syncFacebook(sb: any, account: Account, token: string) {
  let rows = 0;
  const id = account.external_id;

  const page = await fetchJson(
    `${GRAPH}/${id}?fields=name,username,link,followers_count,fan_count,picture.type(large)&access_token=${token}`,
  );

  await sb.from("account_snapshots").upsert({
    account_id: account.id,
    captured_on: today(),
    followers: num(page.followers_count) ?? num(page.fan_count),
    raw: page,
  }, { onConflict: "account_id,captured_on" });
  rows++;

  await sb.from("accounts").update({
    handle: page.username ?? account.handle,
    display_name: page.name ?? account.display_name,
    avatar_url: page.picture?.data?.url ?? null,
    profile_url: page.link ?? null,
  }).eq("id", account.id);

  const since = unix(daysAgo(29));
  const until = unix(today());

  const ins = await tryFetch(
    `${GRAPH}/${id}/insights?metric=page_impressions_unique,page_post_engagements,page_video_views,page_fan_adds&period=day&since=${since}&until=${until}&access_token=${token}`,
    `fb insights ${id}`,
  );
  if (ins) {
    rows += await writeDaily(sb, foldTimeseries(account.id, ins, {
      page_impressions_unique: "reach",
      page_post_engagements: "engagements",
      page_video_views: "views",
      page_fan_adds: "followers_gained",
    }));
  }

  const posts = await tryFetch(
    `${GRAPH}/${id}/posts?fields=id,message,permalink_url,created_time,full_picture,shares,likes.summary(true).limit(0),comments.summary(true).limit(0)&limit=30&access_token=${token}`,
    `fb posts ${id}`,
  );

  for (const p of posts?.data ?? []) {
    const { data: post } = await sb.from("posts").upsert({
      account_id: account.id,
      external_id: p.id,
      published_at: p.created_time ?? null,
      post_type: "post",
      caption: (p.message ?? "").slice(0, 2000),
      title: (p.message ?? "").split("\n")[0].slice(0, 200) || null,
      permalink: p.permalink_url ?? null,
      thumbnail_url: p.full_picture ?? null,
    }, { onConflict: "account_id,external_id" }).select("id").single();
    if (!post) continue;

    const pin = await tryFetch(
      `${GRAPH}/${p.id}/insights?metric=post_impressions_unique,post_video_views&access_token=${token}`,
      `fb post insights ${p.id}`,
    );
    const bag: Record<string, number> = {};
    for (const row of pin?.data ?? []) bag[row.name] = Number(row.values?.[0]?.value ?? 0);

    await sb.from("post_metrics").upsert({
      post_id: post.id,
      captured_on: today(),
      views: bag.post_video_views ?? null,
      likes: num(p.likes?.summary?.total_count),
      comments: num(p.comments?.summary?.total_count),
      shares: num(p.shares?.count),
      raw: bag,
    }, { onConflict: "post_id,captured_on" });
    rows += 2;
  }

  return rows;
}

// --------------------------------------------------------------------------
Deno.serve(async (_req: Request) => {
  const sb = db();
  try {
    const all = await activeAccounts(sb, ["instagram", "facebook"]);

    // Hand back any Instagram account that came in through Business Login for
    // Instagram. Its token is for graph.instagram.com and would fail here.
    const { data: creds } = await sb
      .from("credentials")
      .select("account_id, extra")
      .in("account_id", all.map((a) => a.id));
    const igLogin = new Set(
      (creds ?? []).filter((c: any) => c.extra?.login === "instagram_login").map((c: any) => c.account_id),
    );
    const accounts = all.filter((a) => !igLogin.has(a.id));
    const skipped = all.length - accounts.length;

    if (!accounts.length) {
      return json({
        platform: "meta",
        results: [],
        skipped_instagram_login: skipped,
        note: skipped
          ? "only Instagram Login accounts present; sync-instagram handles those"
          : "no active facebook or page-linked instagram accounts",
      });
    }

    const results = [];
    for (const a of accounts) {
      const runId = await startRun(sb, a.platform, a.id);
      try {
        const cred = await credentialFor(sb, a.id);
        if (!cred?.access_token) throw new Error("no access_token stored for this account");
        const rows = a.platform === "instagram"
          ? await syncInstagram(sb, a, cred.access_token)
          : await syncFacebook(sb, a, cred.access_token);
        await finishRun(sb, runId, "ok", rows);
        results.push({ account: a.display_name ?? a.external_id, platform: a.platform, status: "ok", rows });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await finishRun(sb, runId, "error", 0, msg);
        results.push({ account: a.display_name ?? a.external_id, platform: a.platform, status: "error", error: msg });
      }
    }
    return json({ platform: "meta", api_version: V, skipped_instagram_login: skipped, results });
  } catch (e) {
    return json({ platform: "meta", error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
