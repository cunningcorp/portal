// add-youtube-channel -- register a YouTube channel for public-only tracking,
// with no OAuth at all.
//
//   POST /functions/v1/add-youtube-channel?handle=@tangraminc
//   POST /functions/v1/add-youtube-channel?id=UCxxxxxxxxxxxxxxxxxxxxxx
//
// Why this exists: a Google account owns exactly one channel directly. Every other
// channel is a Brand Account -- a separate identity that the account manages rather
// than is. OAuth authenticates one identity, so channels.list?mine=true only ever
// returns one channel, and a Brand Account cannot authorise an Internal app at all
// (Google returns 403 org_internal, because Brand Accounts are not Workspace users).
//
// Public channel data needs none of that. An API key plus a channel id reads
// subscribers, view counts and the uploads playlist for any public channel, whoever
// owns it. sync-youtube then treats the channel as public-only: it collects
// everything except the private Analytics figures, which still require OAuth.
//
// Required secret: YOUTUBE_API_KEY

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  // Locked to the portal origin, consistent with publish-read/read-diff.
  "Access-Control-Allow-Origin": "https://portal.cunningcorp.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const DATA_API = "https://www.googleapis.com/youtube/v3";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const key = Deno.env.get("YOUTUBE_API_KEY");
  if (!key) return json({ error: "YOUTUBE_API_KEY secret is not set" }, 500);

  const url = new URL(req.url);
  const handle = url.searchParams.get("handle");
  const id = url.searchParams.get("id");
  const brand = url.searchParams.get("brand");

  if (!handle && !id) {
    return json({ error: "pass ?handle=@channelhandle or ?id=UC..." }, 400);
  }

  // forHandle accepts the handle with or without the leading @.
  const filter = id
    ? `id=${encodeURIComponent(id)}`
    : `forHandle=${encodeURIComponent(handle!.replace(/^@/, ""))}`;

  const res = await fetch(
    `${DATA_API}/channels?part=snippet,statistics,contentDetails&${filter}&key=${key}`,
  );
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    return json({
      error: `YouTube Data API ${res.status}`,
      detail: body?.error?.message ?? "no detail",
    }, res.status);
  }

  const ch = body?.items?.[0];
  if (!ch) {
    return json({
      error: "no channel found",
      hint: handle
        ? "check the handle exactly as it appears on the channel page, e.g. @tangraminc"
        : "check the channel id starts UC and is 24 characters",
    }, 404);
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "social" }, auth: { persistSession: false } },
  );

  // Upsert only. If this channel is already connected via OAuth, that row and its
  // credentials are left intact -- adding it here must never downgrade a channel
  // that already has full access.
  const { data: existing } = await sb
    .from("accounts").select("id").eq("platform", "youtube").eq("external_id", ch.id).maybeSingle();

  let hasOauth = false;
  if (existing) {
    const { data: cred } = await sb
      .from("credentials").select("refresh_token").eq("account_id", existing.id).maybeSingle();
    hasOauth = !!cred?.refresh_token;
  }

  const { data: account, error } = await sb.from("accounts").upsert({
    platform: "youtube",
    external_id: ch.id,
    handle: ch.snippet?.customUrl ?? (handle ? handle.replace(/^@?/, "@") : null),
    display_name: ch.snippet?.title ?? null,
    avatar_url: ch.snippet?.thumbnails?.high?.url ?? null,
    profile_url: `https://www.youtube.com/channel/${ch.id}`,
    brand: brand ?? null,
    is_active: true,
    connected_at: new Date().toISOString(),
  }, { onConflict: "platform,external_id" }).select("id, display_name, handle").single();

  if (error) return json({ error: `save account: ${error.message}` }, 500);

  const st = ch.statistics ?? {};
  return json({
    added: {
      account_id: account.id,
      channel_id: ch.id,
      title: account.display_name,
      handle: account.handle,
      subscribers: st.subscriberCount ?? null,
      lifetime_views: st.viewCount ?? null,
      videos: st.videoCount ?? null,
      hidden_subscriber_count: ch.statistics?.hiddenSubscriberCount ?? false,
    },
    access: hasOauth ? "oauth" : "public-only",
    note: hasOauth
      ? "This channel already has OAuth credentials, so it keeps full access including private Analytics. Nothing was downgraded."
      : "Public data only. Daily views, watch time and subscribers gained need OAuth, which a Brand Account cannot grant while the app is Internal.",
    next: "Run sync-youtube to pull the first figures.",
  });
});
