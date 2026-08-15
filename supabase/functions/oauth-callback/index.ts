// oauth-callback -- the redirect target for all three platform consent flows.
//
// verify_jwt is off because the provider redirects the browser here with no
// Authorization header. Access is instead gated on a single-use `state` token
// that oauth-start wrote to social.oauth_states and that expires in 15 minutes.
// Without a matching unconsumed state this function does nothing.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const META_V = Deno.env.get("META_API_VERSION") ?? "v25.0";

function sb(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "social" }, auth: { persistSession: false } },
  );
}

async function post(url: string, body: URLSearchParams) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  const parsed = (() => { try { return JSON.parse(text); } catch { return text; } })();
  if (!res.ok) throw new Error(`${res.status} ${url}: ${text.slice(0, 400)}`);
  return parsed as any;
}

async function get(url: string) {
  const res = await fetch(url);
  const text = await res.text();
  const parsed = (() => { try { return JSON.parse(text); } catch { return text; } })();
  if (!res.ok) throw new Error(`${res.status} ${url.split("?")[0]}: ${text.slice(0, 400)}`);
  return parsed as any;
}

/** Insert or update an account, then store its credentials. */
async function upsertAccount(
  db: SupabaseClient,
  account: Record<string, unknown>,
  cred: Record<string, unknown>,
) {
  const { data, error } = await db
    .from("accounts")
    .upsert({ ...account, connected_at: new Date().toISOString(), is_active: true },
            { onConflict: "platform,external_id" })
    .select("id, platform, display_name, handle")
    .single();
  if (error) throw new Error(`save account: ${error.message}`);

  const { error: cErr } = await db.from("credentials").upsert({
    account_id: data.id,
    platform: data.platform,
    updated_at: new Date().toISOString(),
    ...cred,
  }, { onConflict: "account_id" });
  if (cErr) throw new Error(`save credentials: ${cErr.message}`);

  return data;
}

// ------------------------------------------------------------------ YouTube
async function connectYouTube(db: SupabaseClient, code: string, redirectUri: string) {
  const tok = await post("https://oauth2.googleapis.com/token", new URLSearchParams({
    code,
    client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
    client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  }));
  if (!tok.refresh_token) {
    throw new Error("Google returned no refresh_token. Revoke the app at myaccount.google.com/permissions and connect again.");
  }

  const chans = await get(
    `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true&access_token=${tok.access_token}`,
  );
  const connected = [];
  for (const ch of chans.items ?? []) {
    connected.push(await upsertAccount(db, {
      platform: "youtube",
      external_id: ch.id,
      handle: ch.snippet?.customUrl ?? null,
      display_name: ch.snippet?.title ?? null,
      avatar_url: ch.snippet?.thumbnails?.high?.url ?? null,
      profile_url: `https://www.youtube.com/channel/${ch.id}`,
    }, {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
      scopes: (tok.scope ?? "").split(" ").filter(Boolean),
    }));
  }
  if (!connected.length) throw new Error("No YouTube channel found on that Google account.");
  return connected;
}

// --------------------------------------------------------------------- Meta
async function connectMeta(db: SupabaseClient, code: string, redirectUri: string) {
  const appId = Deno.env.get("META_APP_ID") ?? "";
  const appSecret = Deno.env.get("META_APP_SECRET") ?? "";

  const short = await get(
    `https://graph.facebook.com/${META_V}/oauth/access_token?` + new URLSearchParams({
      client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code,
    }),
  );
  const long = await get(
    `https://graph.facebook.com/${META_V}/oauth/access_token?` + new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: short.access_token,
    }),
  );

  const pages = await get(
    `https://graph.facebook.com/${META_V}/me/accounts?` + new URLSearchParams({
      fields: "id,name,username,link,access_token,instagram_business_account{id,username,name,profile_picture_url}",
      access_token: long.access_token,
    }),
  );

  const connected = [];
  for (const page of pages.data ?? []) {
    // Page tokens derived from a long-lived user token do not expire.
    connected.push(await upsertAccount(db, {
      platform: "facebook",
      external_id: page.id,
      handle: page.username ?? null,
      display_name: page.name ?? null,
      profile_url: page.link ?? `https://facebook.com/${page.id}`,
    }, {
      access_token: page.access_token,
      extra: { page_id: page.id, source: "page_token" },
    }));

    const ig = page.instagram_business_account;
    if (ig?.id) {
      connected.push(await upsertAccount(db, {
        platform: "instagram",
        external_id: ig.id,
        handle: ig.username ?? null,
        display_name: ig.name ?? ig.username ?? null,
        avatar_url: ig.profile_picture_url ?? null,
        profile_url: ig.username ? `https://instagram.com/${ig.username}` : null,
      }, {
        access_token: page.access_token,
        extra: { page_id: page.id, ig_user_id: ig.id },
      }));
    }
  }

  if (!connected.length) {
    throw new Error("No Pages were granted. Instagram must be a Business or Creator account linked to a Facebook Page.");
  }
  return connected;
}

// ------------------------------------------------------------------- TikTok
async function connectTikTok(db: SupabaseClient, code: string, redirectUri: string) {
  const tok = await post("https://open.tiktokapis.com/v2/oauth/token/", new URLSearchParams({
    client_key: Deno.env.get("TIKTOK_CLIENT_KEY") ?? "",
    client_secret: Deno.env.get("TIKTOK_CLIENT_SECRET") ?? "",
    code: decodeURIComponent(code),
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  }));
  if (tok.error) throw new Error(`${tok.error}: ${tok.error_description ?? ""}`);

  const info = await fetch(
    "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username,avatar_url,profile_deep_link",
    { headers: { Authorization: `Bearer ${tok.access_token}` } },
  ).then((r) => r.json());
  const u = info?.data?.user ?? {};

  return [await upsertAccount(db, {
    platform: "tiktok",
    external_id: tok.open_id ?? u.open_id,
    handle: u.username ?? null,
    display_name: u.display_name ?? null,
    avatar_url: u.avatar_url ?? null,
    profile_url: u.profile_deep_link ?? null,
  }, {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: new Date(Date.now() + (tok.expires_in ?? 86400) * 1000).toISOString(),
    scopes: (tok.scope ?? "").split(",").filter(Boolean),
  })];
}

// --------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");

  if (providerError) return page("Connection cancelled", providerError, false);
  if (!code || !state) return page("Missing parameters", "No authorisation code or state was returned.", false);

  const db = sb();

  const { data: st } = await db
    .from("oauth_states")
    .select("*")
    .eq("state", state)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (!st) return page("Expired or invalid link", "That connect link has already been used or has expired. Start again from the portal.", false);

  await db.from("oauth_states").update({ consumed_at: new Date().toISOString() }).eq("state", state);

  const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/oauth-callback`;

  try {
    let connected;
    if (st.platform === "youtube") connected = await connectYouTube(db, code, redirectUri);
    else if (st.platform === "meta") connected = await connectMeta(db, code, redirectUri);
    else if (st.platform === "tiktok") connected = await connectTikTok(db, code, redirectUri);
    else throw new Error(`unknown platform ${st.platform}`);

    if (st.redirect_to) {
      return new Response(null, { status: 302, headers: { Location: `${st.redirect_to}#connected=${connected.length}` } });
    }

    const list = connected
      .map((c) => `<li><strong>${esc(c.display_name ?? c.handle ?? "account")}</strong> <span>${esc(c.platform)}</span></li>`)
      .join("");
    return page("Connected", `<p>${connected.length} account${connected.length === 1 ? "" : "s"} linked. Run a sync from the portal to pull the first numbers in.</p><ul>${list}</ul>`, true);
  } catch (e) {
    return page("Could not connect", esc(e instanceof Error ? e.message : String(e)), false);
  }
});

function esc(s: string) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function page(title: string, body: string, ok: boolean) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e7ebf0;
     font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.card{max-width:32rem;padding:2.5rem;border:1px solid #1e242c;border-radius:14px;background:#11151a}
h1{margin:0 0 .75rem;font-size:1.35rem;color:${ok ? "#5fd39a" : "#f2705f"}}
p{margin:0 0 1rem;color:#9aa6b4}
ul{margin:0;padding-left:1.1rem;color:#c8d2dd}
li span{color:#7d8896;font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;margin-left:.4rem}
code{color:#c8d2dd}
</style></head><body><div class="card"><h1>${esc(title)}</h1>${body.startsWith("<") ? body : `<p>${esc(body)}</p>`}
<p style="margin-top:1.5rem;font-size:.85rem">You can close this tab.</p></div></body></html>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
