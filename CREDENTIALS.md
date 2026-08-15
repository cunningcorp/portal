# Step B — make the data real

Three developer consoles, then one loop per platform: connect, probe, fix, sync.

Do YouTube first. It has the shortest approval path and the richest data, so it's where
you find out whether the whole pipeline works before spending time on Meta's app review.

**The redirect URI is identical for all three:**

```
https://qeafetctmtnqonhwhhlw.supabase.co/functions/v1/oauth-callback
```

Copy it exactly — no trailing slash. Every one of these consoles does exact-string
matching and gives an unhelpful error when it doesn't match.

---

## Where secrets go

Supabase dashboard → project **aubreynorth** → **Edge Functions** → **Secrets** →
**Add new secret**.

| Name | From |
|---|---|
| `GOOGLE_CLIENT_ID` | Google Auth Platform → Clients |
| `GOOGLE_CLIENT_SECRET` | same screen |
| `META_APP_ID` | Meta app → App settings → Basic |
| `META_APP_SECRET` | same screen (click Show) |
| `TIKTOK_CLIENT_KEY` | TikTok app → Basic information |
| `TIKTOK_CLIENT_SECRET` | same screen |
| `META_API_VERSION` | optional, defaults to `v25.0` |

These are the only place the client secrets should ever be typed. Not in the repo, not in
`index.html`, not in a note. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically — don't add them.

---

## 1 · YouTube

Google renamed this console. The old "APIs & Services → OAuth consent screen" page no
longer exists; it's now **Google Auth Platform**, split across Branding / Audience /
Data access / Clients.

**a. Project and APIs.** [console.cloud.google.com](https://console.cloud.google.com) →
project picker (top bar) → **New Project** → name it `cunning-signal` → Create.

**APIs & Services → Library** → search and **Enable** both:
- **YouTube Data API v3**
- **YouTube Analytics API**

Miss the second one and channel totals work while every per-day chart stays empty.

**b. Auth platform.** Left menu → **Google Auth Platform** → **Get started** if it prompts.

- **Branding:** app name `Signal`, your support email, your contact email.
- **Audience:** this depends on where the project lives, and it matters more than it looks.
  - Project inside the **cunningcorp.com organisation** and the channel is on a
    `@cunningcorp.com` account → leave it **Internal**. There is no *Test users* section and
    no publishing status, and that's correct, not a missing step.
  - Channel on a personal Gmail or another domain → **Make external**, then *Test users* →
    **Add users** → that account. Internal means org members only and will refuse anything else.
- **Data access → Add or remove scopes** → add:
  - `https://www.googleapis.com/auth/youtube.readonly`
  - `https://www.googleapis.com/auth/yt-analytics.readonly`

**c. Client.** **Google Auth Platform → Clients** → **Create client**
- Application type: **Web application**
- Name: `Signal portal`
- **Authorised redirect URIs → Add URI** → paste the callback URL above
- **Create** → copy the client ID and secret into Supabase.

**The one that bites a week later — External apps only.** While an External app's
publishing status is *Testing*, Google expires refresh tokens after **7 days**. Syncs work,
then start failing with `invalid_grant`, and it reads like the code broke. Fix it before it
happens: **Audience → Publish app**. Both scopes are read-only and non-sensitive, so
publishing doesn't trigger a review queue.

**Internal apps are exempt.** No publishing status, no test users, no 7-day expiry. If the
Audience page says Internal and offers you none of those things, that is the good outcome —
skip this step entirely.

**Quota:** 10,000 units a day. A full sync of one channel is roughly 10. Not a concern.

---

## 2 · Instagram and Facebook

Prerequisites that are not negotiable, and worth confirming before you start:
- The Instagram account is **Business or Creator**, not personal.
- It is **linked to a Facebook Page**.
- You are an admin of that Page.

Instagram accounts that aren't Page-linked cannot be read by any API at any price.

**a. App.** [developers.facebook.com](https://developers.facebook.com) → **My Apps** →
**Create App** → use case **Other** → type **Business** → name it `Signal`.

**b. Login product.** Dashboard → **Add product** → **Facebook Login for Business** → Set up.
Then **Facebook Login for Business → Settings** → under *Client OAuth settings*, paste the
callback URL into **Valid OAuth Redirect URIs** → **Save changes**.

**c. Secrets.** **App settings → Basic** → copy App ID and App Secret into Supabase.

**d. Leave it in Development mode.** It works fully for Pages you hold a role on, which is
all you need. App Review and Business Verification are only required to read accounts you
don't administer.

**Expect some metrics to fail, by design.** Meta retired `impressions`, `plays` and
`profile_views` across all API versions in April 2025 — `views` replaced them everywhere.
The collector requests a list and tolerates individual failures rather than dying, so a
partial result here is information, not a bug. The probe output tells you exactly which
ones still return.

---

## 3 · TikTok

**a. App.** [developers.tiktok.com](https://developers.tiktok.com) → register → **Manage
apps** → **Create an app**.

**b. Products.** Add **Login Kit** and **Display API**.

**c. Redirect.** Login Kit settings → **Redirect URI** → paste the callback URL.

**d. Scopes.** Request `user.info.basic`, `user.info.profile`, `user.info.stats`,
`video.list`. A scope you don't get doesn't error — the field just quietly goes missing
from the response, which is why the probe matters here more than anywhere else.

**e. Sandbox.** Create a sandbox and add your own TikTok account as a tester. That is
enough to read your own analytics; you do not need full approval for this.

**f. Secrets.** Copy Client Key and Client Secret into Supabase.

Full approval, if you ever want it, needs a privacy policy URL, a demo video of the OAuth
flow and a data-handling description. Roughly one to two weeks for a clean submission.

**Known limitation.** The free Display API returns cumulative totals only — no per-day
timeseries outside the paid Business API. `sync-tiktok` differences consecutive daily
snapshots to derive movement, so TikTok's daily chart stays empty until the sync has run
on two separate days.

---

## 4 · The loop: connect → probe → fix → sync

Do this per platform, one at a time.

**Connect.** Open the portal, sign in, **Connect account**, type the platform
(`youtube`, `meta`, `tiktok`). Approve the consent screen. One Meta connect picks up every
Page you administer plus each linked Instagram account in a single pass.

**Probe before you sync.** There is a read-only `probe` function that calls every endpoint
the collector depends on and returns the raw response, writing nothing:

```bash
# your signed-in JWT, or the service role key from Settings → API
TOKEN="..."
BASE="https://qeafetctmtnqonhwhhlw.supabase.co/functions/v1"

curl -s "$BASE/probe?platform=youtube"   -H "Authorization: Bearer $TOKEN" | jq .
curl -s "$BASE/probe?platform=instagram" -H "Authorization: Bearer $TOKEN" | jq .
curl -s "$BASE/probe?platform=facebook"  -H "Authorization: Bearer $TOKEN" | jq .
curl -s "$BASE/probe?platform=tiktok"    -H "Authorization: Bearer $TOKEN" | jq .
```

Add `&full=1` to stop it trimming arrays to two elements. Tokens are masked in the output,
so it's safe to paste the result into a chat or an issue.

Start with `.summary` — one line per endpoint, `ok` or `FAIL` with the status code. Then
for each endpoint read `top_level_keys` and `payload`, and check them against the `note`
field, which says what the collector assumes about that response.

**What you're looking for:**

| Symptom in probe | What it means |
|---|---|
| `FAIL 403` on YouTube analytics | `yt-analytics.readonly` scope wasn't granted — reconnect |
| `FAIL 400` naming a metric | that metric is retired; drop it from the collector's list |
| Endpoint `ok` but a field absent | field renamed or scope missing; parser needs updating |
| `[empty array]` on media/videos | no content in range, or a permissions issue — not necessarily a bug |
| `invalid_grant` on YouTube | the 7-day test-mode refresh token expired; publish the app |

**Fix, then sync.** Correct the parser in `supabase/functions/<name>/index.ts`, redeploy
with `supabase functions deploy <name>`, then hit **Sync now** in the portal and check the
Sync health panel. Commit the fix with a note about what the API actually returned — that
comment is worth more than the diff in six months.

**Only then set up the cron.** The daily schedule SQL is in `SETUP.md`. Don't automate a
pipeline you haven't watched succeed once by hand.

---

## Reference

- `SETUP.md` — schema reference and the longer-form version of the above
- `CLAUDE.md` — what's locked, what's unproven, known rough edges
- `GO-LIVE.md` — hosting, DNS and auth setup
