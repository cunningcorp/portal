// oauth-callback -- the redirect target for every platform consent flow.
//
// verify_jwt is off because the provider redirects the browser here with no
// Authorization header. Access is instead gated on a single-use `state` token
// that oauth-start wrote to social.oauth_states and that expires in 15 minutes.
// Without a matching unconsumed state this function does nothing.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const META_V = Deno.env.get("META_API_VERSION") ?? "v25.0";

// Post-connect landing is restricted to the portal's own origin so a tampered
// oauth_states.redirect_to can't turn the OAuth flow into an open redirect.
// Anything else falls through to the built-in success page below.
const ALLOWED_REDIRECT_ORIGIN = "https://portal.cunningcorp.com";
function safeRedirect(target: string | null | undefined): string | null {
  if (!target) return null;
  try { return new URL(target).origin === ALLOWED_REDIRECT_ORIGIN ? target : null; }
  catch { return null; }
}

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
// Analytics-only scope, so there is no endpoint that reports which channel just
// consented -- channels.list?mine=true needed the sensitive youtube.readonly scope we
// deliberately dropped. oauth-start therefore records the intended channel on the state
// row, and this verifies the consenting identity can genuinely read that channel's
// analytics before storing anything. Picking the wrong entry at Google's account chooser
// now fails loudly instead of silently attaching the token to the wrong channel.
async function connectYouTube(
  db: SupabaseClient, code: string, redirectUri: string, accountId: string | null,
) {
  if (!accountId) {
    throw new Error(
      "No target channel recorded for this connect flow. Start it with " +
      "oauth-start?platform=youtube&handle=@yourchannel",
    );
  }

  const { data: acct } = await db
    .from("accounts").select("id, external_id, display_name, handle").eq("id", accountId).maybeSingle();
  if (!acct) throw new Error("the target channel no longer exists");

  const tok = await post("https://oauth2.googleapis.com/token", new URLSearchParams({
    code,
    client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
    client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  }));
  if (!tok.refresh_token) {
    throw new Error(
      "Google returned no refresh_token. Revoke the app at myaccount.google.com/permissions and connect again.",
    );
  }

  // Proof of ownership: ask for one day of analytics for this specific channel.
  // A 403 here means the identity that consented does not own it.
  const day = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
  const probe = await fetch(
    "https://youtubeanalytics.googleapis.com/v2/reports?" + new URLSearchParams({
      ids: `channel==${acct.external_id}`,
      startDate: day, endDate: day, metrics: "views",
    }),
    { headers: { Authorization: `Bearer ${tok.access_token}` } },
  );
  if (!probe.ok) {
    const detail = (await probe.text()).slice(0, 300);
    throw new Error(
      `That Google identity cannot read analytics for ${acct.display_name ?? acct.external_id}. ` +
      `You may have picked the wrong entry at the account chooser — pick the one matching ` +
      `this channel and try again. (${probe.status}: ${detail})`,
    );
  }

  return [await upsertAccount(db, {
    platform: "youtube",
    external_id: acct.external_id,
  }, {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    scopes: (tok.scope ?? "").split(" ").filter(Boolean),
  })];
}

// ---------------------------------------------------------------- Instagram
// Business Login for Instagram. Three steps: code -> short-lived token (1 hour)
// -> long-lived token (60 days). Skipping the exchange leaves a token that dies
// before the first scheduled sync.
async function connectInstagram(db: SupabaseClient, code: string, redirectUri: string) {
  const appId = Deno.env.get("INSTAGRAM_APP_ID") ?? "";
  const appSecret = Deno.env.get("INSTAGRAM_APP_SECRET") ?? "";

  // Instagram appends "#_" to the code on the browser redirect. Left in place it
  // produces an opaque "Invalid authorization code" from the token endpoint.
  const clean = decodeURIComponent(code).replace(/#_$/, "");

  const short = await post("https://api.instagram.com/oauth/access_token", new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code: clean,
  }));
  if (short.error_type || short.error_message) {
    throw new Error(`${short.error_type ?? "error"}: ${short.error_message ?? ""}`);
  }

  const long = await get(
    "https://graph.instagram.com/access_token?" + new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: appSecret,
      access_token: short.access_token,
    }),
  );
  const token = long.access_token ?? short.access_token;
  const ttl = long.expires_in ?? 5_184_000; // 60 days

  const me = await get(
    `https://graph.instagram.com/${META_V}/me?` + new URLSearchParams({
      fields: "user_id,username,name,account_type,profile_picture_url",
      access_token: token,
    }),
  );

  if (me.account_type && !/BUSINESS|CREATOR|MEDIA_CREATOR/i.test(me.account_type)) {
    throw new Error(
      `That Instagram account is ${me.account_type}. Insights need a Business or Creator account — switch it in the Instagram app, then reconnect.`,
    );
  }

  return [await upsertAccount(db, {
    platform: "instagram",
    external_id: String(me.user_id ?? short.user_id),
    handle: me.username ?? null,
    display_name: me.name ?? me.username ?? null,
    avatar_url: me.profile_picture_url ?? null,
    profile_url: me.username ? `https://instagram.com/${me.username}` : null,
  }, {
    access_token: token,
    expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    scopes: short.permissions ?? [],
    // How sync-instagram claims this account and sync-meta knows to skip it.
    extra: { login: "instagram_login", ig_user_id: String(me.user_id ?? short.user_id) },
  })];
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
        extra: { page_id: page.id, ig_user_id: ig.id, login: "facebook_login" },
      }));
    }
  }

  if (!connected.length) {
    throw new Error("No Pages were granted. If the Instagram account has no Facebook Page, use the instagram platform instead of meta.");
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

  if (providerError) return page("Connection cancelled", text(providerError), false);
  if (!code || !state) return page("Missing parameters", text("No authorisation code or state was returned."), false);

  const db = sb();

  // Claim the state atomically: the conditional update both consumes it and returns
  // the row, so two concurrent callbacks can't both pass an unconsumed check (TOCTOU).
  const { data: claimedStates } = await db
    .from("oauth_states")
    .update({ consumed_at: new Date().toISOString() })
    .eq("state", state)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("*");
  const st = claimedStates?.[0];

  if (!st) {
    return page("Expired or invalid link",
      text("That connect link has already been used or has expired. Start again from the portal."), false);
  }

  const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/oauth-callback`;

  try {
    let connected;
    if (st.platform === "youtube")        connected = await connectYouTube(db, code, redirectUri, st.account_id ?? null);
    else if (st.platform === "instagram") connected = await connectInstagram(db, code, redirectUri);
    else if (st.platform === "meta")      connected = await connectMeta(db, code, redirectUri);
    else if (st.platform === "tiktok")    connected = await connectTikTok(db, code, redirectUri);
    else throw new Error(`unknown platform ${st.platform}`);

    const dest = safeRedirect(st.redirect_to);
    if (dest) {
      return new Response(null, {
        status: 302,
        headers: { Location: `${dest}#connected=${connected.length}` },
      });
    }

    const list = connected
      .map((c) => `<li><strong>${esc(c.display_name ?? c.handle ?? "account")}</strong> <span>${esc(c.platform)}</span></li>`)
      .join("");
    return page(
      "Connected",
      `<p>${connected.length} account${connected.length === 1 ? "" : "s"} linked. Run a sync to pull the first numbers in.</p><ul>${list}</ul>`,
      true,
    );
  } catch (e) {
    return page("Could not connect", text(e instanceof Error ? e.message : String(e)), false);
  }
});

function esc(s: string) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * Wrap plain text as escaped HTML. page() takes HTML, so callers must escape exactly
 * once -- an earlier version escaped in both places and rendered provider errors as
 * &amp;quot;, which is unhelpful precisely when you need to read them.
 */
const text = (s: string) => `<p>${esc(s)}</p>`;

function page(title: string, bodyHtml: string, ok: boolean) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#191220;color:#FAF6EE;
     font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.card{max-width:34rem;padding:2.5rem;border:1px solid #372c47;border-radius:14px;background:#241B30}
h1{margin:0 0 .75rem;font-size:1.35rem;font-weight:400;color:${ok ? "#C8A24C" : "#C0593B"}}
p{margin:0 0 1rem;color:#B7AEC2;word-break:break-word}
ul{margin:0;padding-left:1.1rem;color:#FAF6EE}
li span{color:#7d7290;font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;margin-left:.4rem}
</style></head><body><div class="card"><h1>${esc(title)}</h1>${bodyHtml}
<p style="margin-top:1.5rem;font-size:.85rem;color:#7d7290">You can close this tab.</p></div></body></html>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
