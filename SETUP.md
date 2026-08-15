# Social Portal — build notes and setup

A single dashboard over YouTube, Instagram, Facebook and TikTok. Built on the existing
`aubreynorth` Supabase project (`qeafetctmtnqonhwhhlw`, eu-central-1).

Nothing in this system scrapes. Every number comes from the platform's own API, on your
own credentials, stored in your own database. That means the data is trustworthy and
won't break when a page layout changes — but it also means each platform has to let you
in first, which is the bulk of the work below.

---

## What exists now

**Database — the `social` schema**

| Table | Holds |
|---|---|
| `accounts` | One row per connected channel or profile |
| `credentials` | OAuth tokens. RLS on, zero policies — service role only, never reaches the browser |
| `account_snapshots` | Daily cumulative totals: followers, lifetime views, post count |
| `daily_metrics` | Long-format per-day timeseries: views, watch time, reach, followers gained |
| `posts` | Individual videos, reels, images, posts |
| `post_metrics` | Per-post views, likes, comments, shares, saves — captured daily |
| `sync_runs` | Every collector run, with status and error text |
| `oauth_states` | Single-use CSRF tokens for the connect flow, 15-minute expiry |

**Read views in `public`** (the frontend only touches these, all `security_invoker`):
`social_accounts_overview` · `social_account_series` · `social_daily_totals` ·
`social_top_posts` · `social_sync_health`

**Edge functions**

| Function | JWT | Purpose |
|---|---|---|
| `sync-youtube` | required | Channel stats, daily analytics, last 50 uploads |
| `sync-meta` | required | IG Business profile + insights + media; FB Page + posts |
| `sync-tiktok` | required | Creator stats and last 20 videos |
| `sync-all` | required | Runs all three in parallel — this is the cron target |
| `oauth-start` | required | Returns the consent URL for a platform |
| `oauth-callback` | none | Redirect target; gated on a single-use state token |

**Frontend** — `social-portal.html`, one file, no build step.

---

## Step 1 — Set the secrets

Supabase dashboard → **Edge Functions → Secrets**:

```
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
META_APP_ID
META_APP_SECRET
TIKTOK_CLIENT_KEY
TIKTOK_CLIENT_SECRET
META_API_VERSION      # optional, defaults to v25.0
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

The redirect URI every platform needs is the same one:

```
https://qeafetctmtnqonhwhhlw.supabase.co/functions/v1/oauth-callback
```

---

## Step 2 — Lock down who can sign in

The portal uses Supabase magic-link auth. Out of the box anyone with the URL could
request a link and read your numbers. Two minutes of hardening:

Dashboard → **Authentication → Sign In / Providers → Email** → turn **off** "Allow new
users to sign up". Then create your own user under **Authentication → Users → Add user**.
After that only accounts you create by hand can get in.

---

## Step 3 — YouTube (Google Cloud)

The best API of the three. Free quota, real per-day analytics, no approval queue for
your own channels.

1. [console.cloud.google.com](https://console.cloud.google.com) → create a project.
2. **APIs & Services → Library** → enable **YouTube Data API v3** and **YouTube Analytics API**.
3. **OAuth consent screen** → External. Add yourself as a Test user. You do not need to
   publish or get verified while you are the only user — test mode is fine indefinitely
   for personal channels, though refresh tokens expire after 7 days in test mode, so
   publish the app (no review needed for these scopes) once it works.
4. **Credentials → Create credentials → OAuth client ID → Web application**. Add the
   redirect URI above. Copy the client ID and secret into the Supabase secrets.

Scopes requested: `youtube.readonly`, `yt-analytics.readonly`.

**Quota note:** the Data API gives 10,000 units a day. One full sync of one channel costs
roughly 10 units, so a daily cron across a handful of channels uses well under 1% of it.

---

## Step 4 — Instagram and Facebook (Meta)

The awkward one. Requirements before anything works:

- The Instagram account must be **Business or Creator**, not personal.
- It must be **linked to a Facebook Page**. Instagram-only accounts cannot be read.
- You must be an admin of that Page.

Setup:

1. [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App** →
   type **Business**.
2. Add the **Facebook Login for Business** product. Under its settings add the redirect URI.
3. Copy App ID and App Secret into the Supabase secrets.
4. While the app is in **Development mode** it works fully for accounts where you hold a
   role. That is enough for your own channels. You only need App Review (and a Business
   Verification) if you ever want to read accounts you don't administer.

Permissions requested: `pages_show_list`, `pages_read_engagement`, `read_insights`,
`instagram_basic`, `instagram_manage_insights`, `business_management`.

**Metric caveat worth knowing:** Meta deprecated `impressions`, `plays`, and
`profile_views` across all API versions from 21 April 2025. `views` is the single
replacement everywhere. The collector already stores `views` and tolerates any individual
metric being retired — if Meta kills one, the rest of the sync still lands rather than
the whole run failing.

---

## Step 5 — TikTok

The most restricted, and the one to set expectations on.

1. [developers.tiktok.com](https://developers.tiktok.com) → register → **Manage apps →
   Create an app**.
2. Add the **Login Kit** and **Display API** products.
3. Add the redirect URI. Copy Client Key and Client Secret into the Supabase secrets.
4. Add your own TikTok account as a sandbox tester — you get up to five sandboxes per app,
   each shareable with ten accounts. Sandbox access is enough to read your own analytics.
5. Full app approval needs a privacy policy URL, a demo video of the OAuth flow, and a
   data-handling description. A clean submission clears in roughly one to two weeks.

Scopes requested: `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`.

**Limitation, stated plainly:** the free Display API returns cumulative totals only. There
is no per-day timeseries outside the paid Business API. The collector works around this by
differencing consecutive daily snapshots, so TikTok's daily-views line stays empty until
the sync has run on two separate days, and it will be approximate rather than exact.

---

## Step 6 — Connect the accounts

Open `social-portal.html`, sign in, hit **Connect account**, pick `youtube`, `meta`, or
`tiktok`. A consent window opens; approving it writes the account and its tokens back to
the database. One Meta connect picks up every Page you administer plus each linked
Instagram Business account in a single pass.

Then hit **Sync now**. The first sync backfills 35 days of YouTube analytics and 30 days
of Meta insights. Follower history builds forward from today — nobody's API hands you
historical follower counts, so that curve starts flat and grows real from here.

---

## Step 7 — Schedule the daily sync

`pg_cron` and `pg_net` are already enabled. Run this once in the SQL editor, pasting your
service role key (Settings → API → service_role):

```sql
select cron.schedule(
  'social-sync-daily',
  '15 3 * * *',                        -- 03:15 UTC, after platform analytics settle
  $$
  select net.http_post(
    url     := 'https://qeafetctmtnqonhwhhlw.supabase.co/functions/v1/sync-all',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
               ),
    body    := '{}'::jsonb
  );
  $$
);
```

Check it later with `select * from cron.job;` and
`select * from cron.job_run_details order by start_time desc limit 10;`.

Storing the key in the job definition is the pragmatic option. If you'd rather not have it
sitting in a table, put it in Supabase Vault and read it with
`vault.decrypted_secrets` inside the job body instead.

---

## Step 8 — Host the dashboard

The file is self-contained and holds no secrets beyond the publishable key, which is
designed to be public and is useless without a session. Any of these work:

- Open it locally by double-clicking — fine for one person.
- Drag it onto Netlify Drop or Cloudflare Pages for a URL you can reach from your phone.
- Drop it in a Supabase Storage public bucket.

If you host it anywhere other than localhost, add that origin to **Authentication → URL
Configuration → Redirect URLs** so the magic link comes back to the right place.

---

## Reading the dashboard

- **Total followers** sums every connected account. The 7d and 28d figures are computed
  from snapshots, so they only mean something once you have that much history.
- **Watch time** is YouTube-only — no other platform exposes it on a free API.
- **Views** is the metric to trust across platforms now that Meta has consolidated
  impressions and plays into it. It counts replays, so it is a reach-ish number, not a
  unique-humans number.
- **Eng %** is (likes + comments + shares + saves) ÷ views. Comparable within a platform,
  only loosely comparable across them, because each platform counts views differently.
- **Sync health** is the first place to look when a number stops moving. A red LED carries
  the API's own error text in its tooltip.

---

## Known gaps and honest limits

- **No historical backfill for followers.** Day one is day one. YouTube analytics
  backfills 35 days; follower curves do not.
- **TikTok daily data is derived, not reported.** See Step 5.
- **Facebook Page insights are shrinking.** Meta has retired a lot of Page metrics; the
  collector requests a set and skips whatever comes back as an error rather than failing.
- **Instagram Stories expire in 24h.** They are only captured if a sync runs while they
  are live, which the daily cron will mostly miss. Worth a second cron if Stories matter.
- **X and LinkedIn are absent by choice.** X now charges for API access at a level that
  isn't worth it for follower counts; LinkedIn restricts organic analytics to approved
  partners. Both would be manual-entry only.

## One pre-existing issue found

The database linter flags a function in this project that predates the portal:
`public.rls_auto_enable()` is `SECURITY DEFINER` and callable by both `anon` and
`authenticated` via `/rest/v1/rpc/rls_auto_enable`. It isn't part of the social portal, but
it is reachable from the public API. Worth either revoking execute on it or switching it to
`SECURITY INVOKER`.
