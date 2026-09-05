// sign-coverage-script -- mints a short-lived signed URL for an order's uploaded script PDF.
// The coverage-scripts bucket is private with zero policies, so this service-role function is
// the ONLY path to the file. The portal Orders tab calls it on "View script", so the link is
// always fresh -- it can never be the stale emailed one. Reads one column, signs, returns the
// URL; touches nothing else. (PORTAL-ORDERS-SPEC §2, recommended option.)
//
//   POST /functions/v1/sign-coverage-script   { "order_id": "<uuid>" }  ->  { url }
//
// Auth: verify_jwt=true (a signed-in portal session). CORS locked to the portal origin.
// Secret: SUPABASE_SERVICE_ROLE_KEY (auto-injected) -- never in client code.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "coverage-scripts";
const TTL_SECONDS = 300;   // 5 minutes: long enough to open, short enough not to linger

const CORS = {
  "Access-Control-Allow-Origin": "https://portal.cunningcorp.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const { order_id } = await req.json().catch(() => ({})) as { order_id?: string };
  if (!order_id) return json({ error: "body must be { order_id }" }, 400);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: row, error } = await sb
    .from("coverage_orders").select("script_path").eq("id", order_id).maybeSingle();
  if (error) return json({ error: `load: ${error.message}` }, 500);
  if (!row) return json({ error: "no such order" }, 404);
  if (!row.script_path) return json({ error: "this order has no script on file" }, 404);

  const { data: signed, error: signErr } = await sb.storage
    .from(BUCKET).createSignedUrl(row.script_path, TTL_SECONDS);
  if (signErr || !signed?.signedUrl) return json({ error: `could not sign: ${signErr?.message ?? "unknown"}` }, 502);

  return json({ url: signed.signedUrl });
});
