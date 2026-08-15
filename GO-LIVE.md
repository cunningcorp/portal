# Go live — portal.cunningcorp.com

Exact click-path. Roughly 20 minutes of work plus DNS propagation.

Do these in order. DNS goes **before** the GitHub custom domain, because the CNAME file
is already committed — the moment Pages is enabled it will try to verify
`portal.cunningcorp.com` and will sit in an error state until the record exists.

---

## 1 · Push the repo

The local repo is committed, on `main`, with the remote already set to
`https://github.com/cunningcorp/portal.git`.

**On github.com:** top-right **+** → **New repository**
- Owner: `cunningcorp`
- Repository name: `portal`
- Visibility: your call — see the note at the bottom
- **Leave "Add a README", ".gitignore" and "license" all unticked.** Any of them creates
  a commit on the remote and your push will be rejected as non-fast-forward.
- **Create repository**

**In Terminal:**

```bash
cd ~/Documents/GitHub/portal
git push -u origin main
```

**Check:** the repo shows two commits and 17 files including `index.html`, `CNAME`,
`supabase/`.

---

## 2 · DNS at Squarespace

**squarespace.com** → sign in → **Domains** → click **cunningcorp.com** → **DNS** →
scroll to **Custom Records** → **Add Record**

| Field | Value |
|---|---|
| Type | `CNAME` |
| Host | `portal` |
| Data / Value | `cunningcorp.github.io` |

**Save.**

Notes:
- Host is `portal` alone, not `portal.cunningcorp.com` — Squarespace appends the domain.
- The value has no `https://`, no trailing slash, and **no** `/portal` path. A CNAME
  points at a hostname only.
- Leave TTL at the default.
- If Squarespace refuses because a record already exists on that host, delete the
  conflicting one first. It will usually be a parking or forwarding record.

**Check** — in Terminal, after a few minutes:

```bash
dig +short portal.cunningcorp.com
```

You want `cunningcorp.github.io` (and then a GitHub IP) in the answer. Squarespace
usually propagates in minutes, but their help pages quote up to 48 hours. If nothing
comes back, wait before moving on — step 4 will just fail.

---

## 3 · Turn on GitHub Pages

**Repo → Settings → Pages** (left sidebar, under "Code and automation")

- **Source:** *Deploy from a branch*
- **Branch:** `main`, folder `/ (root)` → **Save**

Wait for the build. **Actions** tab shows a "pages build and deployment" run; it takes
under a minute.

**Check:** `https://cunningcorp.github.io/portal/` loads the Signal sign-in screen. Don't
sign in yet — the redirect URL isn't configured.

---

## 4 · Custom domain and HTTPS

Still on **Settings → Pages**:

- **Custom domain** should already read `portal.cunningcorp.com`, picked up from the
  committed `CNAME` file. If it's empty, type it in and **Save**.
- GitHub runs a DNS check. Green tick means step 2 propagated.
- Wait for **"Certificate created"** under the domain field. Usually a few minutes, can be
  up to an hour on a fresh record.
- Once the certificate exists, tick **Enforce HTTPS**.

**Check:** `https://portal.cunningcorp.com` loads with a valid padlock.

If it says "Domain's DNS record could not be verified", the CNAME hasn't propagated. Click
**Remove** on the custom domain, wait, re-add. Don't delete the `CNAME` file from the repo.

---

## 5 · Supabase — redirect URLs

Sign-in fails **silently** without this. The magic link arrives, you click it, and you land
back on the sign-in screen with no error.

**supabase.com/dashboard** → project **aubreynorth** → **Authentication** (left sidebar) →
**URL Configuration**

| Field | Value |
|---|---|
| Site URL | `https://portal.cunningcorp.com` |
| Redirect URLs → Add URL | `https://portal.cunningcorp.com` |
| Redirect URLs → Add URL | `https://portal.cunningcorp.com/**` |

**Save.**

The wildcard entry covers the `#access_token=…` fragment the magic link comes back with.

---

## 6 · Supabase — close signups, then invite yourself

Do this in this order. Inviting is an admin action and still works with signups off.

**a. Close signups.** **Authentication → Sign In / Providers → Email**
- Turn **off** *Allow new users to sign up*
- **Save**

**b. Invite yourself.** **Authentication → Users** → **Add user** ▾ → **Send invitation**
- Email: `demetri@mauricejames.uk`
- **Send invite**

Use *Send invitation*, not *Create new user* — the latter asks you to set a password, and
the portal doesn't use passwords at all.

**Check:** the invite email arrives, clicking it lands you on the portal signed in, and you
see the empty dashboard with "Nothing connected yet".

Then confirm the lockout works: sign out, enter an address that isn't a user, request a
link. You should get an error rather than a new account. The page also passes
`shouldCreateUser: false`, so this is enforced in two places.

---

## Done — and what's still not true

At this point the portal is live, private and empty. It stays empty until the platform
credentials exist: that's `SETUP.md`, and it's the longer job — Google Cloud is quick,
Meta needs a Business app and a Page-linked Instagram account, TikTok needs a sandbox and
eventually an audit.

## One decision left: public or private repo

Either works, and Pages serves the site publicly regardless.

**Private** hides the source. Worth knowing this buys less than it looks like: the
publishable Supabase key is designed to be public, it grants nothing without a session,
and anyone can read the deployed `index.html` from the live URL anyway. GitHub Pages on
private repos is a paid feature on some plans — check before relying on it.

**Public** means the collectors, schema and brand notes are readable by anyone. Nothing in
this repo is a secret: no service role key, no OAuth client secrets, no tokens. Those all
live in Supabase Edge Function secrets and `social.credentials`.

The genuine control here is step 6, not repo visibility.
