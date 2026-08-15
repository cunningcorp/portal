import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** Service-role client bound to the `social` schema. */
export function db(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, {
    db: { schema: "social" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type Account = {
  id: string;
  platform: string;
  external_id: string;
  handle: string | null;
  display_name: string | null;
};

export type Credential = {
  account_id: string;
  platform: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  extra: Record<string, unknown>;
};

export async function activeAccounts(sb: SupabaseClient, platform: string | string[]) {
  const platforms = Array.isArray(platform) ? platform : [platform];
  const { data, error } = await sb
    .from("accounts")
    .select("id, platform, external_id, handle, display_name")
    .in("platform", platforms)
    .eq("is_active", true);
  if (error) throw new Error(`load accounts: ${error.message}`);
  return (data ?? []) as Account[];
}

export async function credentialFor(sb: SupabaseClient, accountId: string) {
  const { data, error } = await sb
    .from("credentials")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw new Error(`load credentials: ${error.message}`);
  return data as Credential | null;
}

export async function saveToken(
  sb: SupabaseClient,
  accountId: string,
  patch: Partial<Credential>,
) {
  await sb
    .from("credentials")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("account_id", accountId);
}

export async function startRun(sb: SupabaseClient, platform: string, accountId?: string) {
  const { data, error } = await sb
    .from("sync_runs")
    .insert({ platform, account_id: accountId ?? null, status: "running" })
    .select("id")
    .single();
  if (error) throw new Error(`start run: ${error.message}`);
  return data.id as number;
}

export async function finishRun(
  sb: SupabaseClient,
  id: number,
  status: "ok" | "error" | "skipped",
  rows = 0,
  message?: string,
) {
  await sb
    .from("sync_runs")
    .update({
      status,
      rows_written: rows,
      message: message?.slice(0, 2000) ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", id);
}

/** yyyy-mm-dd, n days before today (UTC). */
export function daysAgo(n: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export const today = () => new Date().toISOString().slice(0, 10);

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${url.split("?")[0]} :: ${text.slice(0, 500)}`);
  }
  return body as any;
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Chunk an array into batches of n. */
export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
