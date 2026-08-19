// oauth-start -- returns the consent URL for a platform and records a CSRF state.
// Called from the portal (signed-in users only; verify_jwt is on).
//
//   GET /functions/v1/oauth-start?platform=instagram
//   GET /functions/v1/oauth-start?platform=youtube&account=<uuid>
//   GET /functions/v1/oauth-start?platform=youtube&handle=@channelhandle
//   -> { "url": "https://accounts.google.com/o/oauth2/v2/auth?..." }
//
// Platforms:
//   youtube    Google OAuth, YouTube Analytics only. Requires a target channel.
//   instagram  Business Login for Instagram (no Facebook Page required)
//   meta       Facebook Login for Business (Pages, and Page-linked Instagram)
//   tiktok     TikTok Login Kit
//
// Why YouTube needs a target: the app requests only yt-analytics.readonly, and no
// endpoint under that scope will tell you which channel just consented. The Analytics
// API reports on a channel you name; it does not name one for you. So the channel is
// registered first with add-youtube-channel, and the connect flow is pointed at it.
// oauth-callback then verifies the consenting identity can actually read that channel
// before storing the token.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  // Locked to the portal origin, consistent with publish-read/read-diff.
  "Access-Control-Allow-Origin": "https://portal.cunningcorp.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const META_V = Deno.env.get("META_API_VERSION") ?? "v25.0";

const SCOPES = {
  // Analytics only, deliberately. youtube.readonly is a *sensitive* scope, and an app
  // requesting it cannot be published External without Google verification. Everything
  // it used to fetch -- channel totals, uploads, per-video stats -- is public data that
  // sync-youtube now reads with an API key.
  //
  // This matters beyond tidiness: an Internal app cannot be authorised by a Brand
  // Account at all (403 org_internal), and most channels are Brand Accounts. Dropping
  // the sensitive scope is what lets the consent screen go External without review,
  // which is the only route to Analytics for those channels.
  youtube: "https://www.googleapis.com/auth/yt-analytics.readonly",
  instagram: [
    "instagram_business_basic",
    "instagram_business_manage_insights",
  ].join(","),
  meta: [
    "pages_show_list",
    "pages_read_engagement",
    "read_insights",
    "instagram_basic",
    "instagram_manage_insights",
    "business_management",
  ].join(","),
  tiktok: [
    "user.info.basic",
    "user.info.profile",
    "user.info.stats",
    "video.list",
  ].join(","),
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const platform = (url.searchParams.get("platform") ?? "").toLowerCase();
  const redirectTo = url.searchParams.get("redirect_to");
  const accountParam = url.searchParams.get("account");
  const handleParam = url.searchParams.get("handle");

  if (!(platform in SCOPES)) {
    return json({ error: `platform must be one of: ${Object.keys(SCOPES).join(", ")}` }, 400);
  }

  const base = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(base, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    db: { schema: "social" },
    auth: { persistSession: false },
  });

  // --- Resolve the target channel for YouTube --------------------------------
  let accountId: string | null = null;
  let target: any = null;
  if (platform === "youtube") {
    let q = sb.from("accounts").select("id, display_name, handle, external_id").eq("platform", "youtube");
    if (accountParam) q = q.eq("id", accountParam);
    else if (handleParam) q = q.ilike("handle", handleParam.replace(/^@?/, "@"));
    else {
      const { data: all } = await sb
        .from("accounts").select("id, display_name, handle").eq("platform", "youtube").eq("is_active", true);
      return json({
        error: "which channel? pass ?account=<uuid> or ?handle=@channelhandle",
        why: "the app requests analytics-only scope, under which no endpoint reports which channel consented",
        known_channels: all ?? [],
        hint: "not listed? register it first: POST /functions/v1/add-youtube-channel?handle=@...",
      }, 400);
    }

    const { data: acct } = await q.maybeSingle();
    if (!acct) {
      return json({
        error: "no matching YouTube channel is registered",
        hint: "register it first: POST /functions/v1/add-youtube-channel?handle=@...",
      }, 404);
    }
    accountId = acct.id;
    target = acct;
  }

  const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const { error } = await sb.from("oauth_states")
    .insert({ state, platform, redirect_to: redirectTo, account_id: accountId });
  if (error) return json({ error: `could not store state: ${error.message}` }, 500);

  const redirectUri = `${base}/functions/v1/oauth-callback`;
  let authUrl: string;

  if (platform === "youtube") {
    const id = Deno.env.get("GOOGLE_CLIENT_ID");
    if (!id) return json({ error: "GOOGLE_CLIENT_ID secret is not set" }, 500);
    authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.youtube,
      access_type: "offline",
      // select_account forces the chooser every time. Without it Google silently reuses
      // whatever session the browser already has, which is how a Brand Account connect
      // ends up authenticating as the personal account instead -- the failure looks like
      // a permissions problem rather than the wrong identity.
      prompt: "select_account consent",
      state,
    });
  } else if (platform === "instagram") {
    // Business Login for Instagram. Note the Instagram app id, which is NOT the
    // Meta app id -- it lives under Instagram -> API setup with Instagram login.
    const id = Deno.env.get("INSTAGRAM_APP_ID");
    if (!id) return json({ error: "INSTAGRAM_APP_ID secret is not set" }, 500);
    authUrl = "https://www.instagram.com/oauth/authorize?" + new URLSearchParams({
      client_id: id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.instagram,
      state,
    });
  } else if (platform === "meta") {
    const id = Deno.env.get("META_APP_ID");
    if (!id) return json({ error: "META_APP_ID secret is not set" }, 500);
    authUrl = `https://www.facebook.com/${META_V}/dialog/oauth?` + new URLSearchParams({
      client_id: id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.meta,
      state,
    });
  } else {
    const key = Deno.env.get("TIKTOK_CLIENT_KEY");
    if (!key) return json({ error: "TIKTOK_CLIENT_KEY secret is not set" }, 500);
    authUrl = "https://www.tiktok.com/v2/auth/authorize/?" + new URLSearchParams({
      client_key: key,
      scope: SCOPES.tiktok,
      response_type: "code",
      redirect_uri: redirectUri,
      state,
    });
  }

  return json({
    platform,
    connecting: target ? { channel: target.display_name, handle: target.handle, channel_id: target.external_id } : undefined,
    pick_at_chooser: target?.display_name,
    url: authUrl,
    redirect_uri: redirectUri,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
