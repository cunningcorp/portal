// search-connect -- one-shot OAuth connect for the Search Signal collector, isolated from the
// shared oauth-* functions so the live connect flows are untouched. The org blocks
// downloadable service-account keys, so Google is authenticated by user consent instead.
//
//   GET /functions/v1/search-connect            -> mints a consent URL, 302s to Google
//   GET /functions/v1/search-connect?code&state -> Google's redirect; validates state,
//                                                   exchanges the code, stores the refresh token
//
// verify_jwt=false (Google's redirect carries no Authorization header); gated on a single-use
// CSRF state in social.oauth_states, exactly like oauth-callback. Before storing, it PROVES the
// consenting identity can read the property in Search Console, so a stray consent from the wrong
// Google account can't overwrite the token with a useless one. Reuses GOOGLE_CLIENT_ID/SECRET.
// Config: GSC_PROPERTY env (default sc-domain:aubreynorth.com).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const db = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

function page(title: string, body: string, ok: boolean): Response {
  return new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
    `<title>${title}</title><body style="font:16px/1.6 system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#191220;color:#FAF6EE">` +
    `<div style="max-width:34rem;padding:2rem"><h1 style="font-weight:600;color:${ok ? "#8E8BD8" : "#C0593B"}">${title}</h1><p style="color:#B7AEC2">${body}</p></div>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const provErr = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const property = Deno.env.get("GSC_PROPERTY") ?? "sc-domain:aubreynorth.com";
  const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/search-connect`;
  const sb = db();

  if (!clientId || !clientSecret) return page("Not configured", "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.", false);
  if (provErr) return page("Connection cancelled", esc(provErr), false);

  // START: no code -> mint a CSRF state and redirect to Google consent.
  if (!code) {
    const st = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const { error } = await sb.schema("social").from("oauth_states").insert({ state: st, platform: "search" });
    if (error) return page("Could not start", esc(error.message), false);
    const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: "code",
      scope: SCOPE, access_type: "offline", prompt: "consent", state: st,
    });
    return new Response(null, { status: 302, headers: { Location: authUrl } });
  }

  // CALLBACK: claim the state atomically (single-use), then exchange the code.
  if (!state) return page("Missing state", "No state was returned.", false);
  const { data: claimed } = await sb.schema("social").from("oauth_states")
    .update({ consumed_at: new Date().toISOString() })
    .eq("state", state).eq("platform", "search").is("consumed_at", null).gt("expires_at", new Date().toISOString())
    .select("state");
  if (!claimed?.length) return page("Expired or used link", "That connect link was already used or has expired. Start again.", false);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok) return page("Token exchange failed", esc(JSON.stringify(tok).slice(0, 300)), false);
  if (!tok.refresh_token) return page("No refresh token", "Google returned no refresh_token. Revoke the app at myaccount.google.com/permissions and connect again.", false);

  // Prove the consenting identity can actually read the property before storing the token.
  const sites = await fetch("https://www.googleapis.com/webmasters/v3/sites", { headers: { Authorization: `Bearer ${tok.access_token}` } });
  const sj = await sites.json().catch(() => ({}));
  const owns = (sj.siteEntry ?? []).some((e: any) => e.siteUrl === property && ["siteOwner", "siteFullUser", "siteRestrictedUser"].includes(e.permissionLevel));
  if (!owns) {
    const have = (sj.siteEntry ?? []).map((e: any) => e.siteUrl).join(", ") || "none";
    return page("No access to the property", `That Google account can't read <b>${esc(property)}</b> in Search Console. It can read: ${esc(have)}. Consent with an account that has access, or set GSC_PROPERTY to match.`, false);
  }

  await sb.from("search_oauth").upsert({
    id: 1, refresh_token: tok.refresh_token, access_token: tok.access_token,
    expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    scopes: (tok.scope ?? "").split(" ").filter(Boolean), updated_at: new Date().toISOString(),
  }, { onConflict: "id" });

  return page("Connected", `Search Console is connected for <b>${esc(property)}</b>. You can close this tab — the collector can now pull data.`, true);
});
