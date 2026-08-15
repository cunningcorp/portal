// sync-all -- orchestrator. Fans out to every platform collector, in parallel,
// and returns a combined report. This is the function the daily cron calls.
//
// Invoke with the service role key:
//   curl -X POST "$SUPABASE_URL/functions/v1/sync-all" \
//        -H "Authorization: Bearer $SERVICE_ROLE_KEY"

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const COLLECTORS = ["sync-youtube", "sync-meta", "sync-tiktok"] as const;

Deno.serve(async (req: Request) => {
  const base = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Allow ?only=sync-youtube to run a single collector.
  const only = new URL(req.url).searchParams.get("only");
  const targets = only ? COLLECTORS.filter((c) => c === only) : [...COLLECTORS];

  if (!targets.length) {
    return new Response(
      JSON.stringify({ error: `unknown collector "${only}"`, available: COLLECTORS }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const started = Date.now();
  const settled = await Promise.allSettled(
    targets.map(async (name) => {
      const res = await fetch(`${base}/functions/v1/${name}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      });
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = text.slice(0, 1000);
      }
      return { collector: name, http: res.status, body };
    }),
  );

  const results = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { collector: targets[i], http: 0, body: { error: String(s.reason) } }
  );

  const failed = results.filter((r) => r.http >= 400 || r.http === 0).length;

  return new Response(
    JSON.stringify({
      ran_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      collectors: targets.length,
      failed,
      results,
    }, null, 2),
    {
      status: failed && failed === targets.length ? 502 : 200,
      headers: { "Content-Type": "application/json" },
    },
  );
});
