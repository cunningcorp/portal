// oauth-start -- returns the consent URL for a platform and records a CSRF state.
// Called from the portal (signed-in users only; verify_jwt is on).
//
//   GET /functions/v1/oauth-start?platform=youtube
//   -> { "url": "https://accounts.google.com/o/oauth2/v2/auth?..." }
//
// Platforms:
//   youtube    Google OAuth
//   instagram  Business Login for Instagram (no Facebook Page required)
//   meta       Facebook Login for Business (Pages, and Page-linked Instagram)
//   tiktok     TikTok Login Kit
//
// instagram and meta are genuinely different products, not two names for one thing.
// They use different app credentials, different hosts and different scopes.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const META_V = Deno.env.get("META_API_VERSION") ?? "v25.0";

const SCOPES = {
  youtube: [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
  ].join(" "),
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

  if (!(platform in SCOPES)) {
    return json({ error: `platform must be one of: ${Object.keys(SCOPES).join(", ")}` }, 400);
  }

  const base = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(base, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    db: { schema: "social" },
    auth: { persistSession: false },
  });

  const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const { error } = await sb.from("oauth_states").insert({ state, platform, redirect_to: redirectTo });
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
      prompt: "consent",
      include_granted_scopes: "true",
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

  return json({ platform, url: authUrl, redirect_uri: redirectUri });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
