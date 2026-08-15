# Signal — Cunning Corp social portal

One dashboard across YouTube, Instagram, Facebook and TikTok. Static page on GitHub
Pages, backed by the `aubreynorth` Supabase project (`qeafetctmtnqonhwhhlw`).

Live at **portal.cunningcorp.com**. Internal tool — `robots.txt` disallows everything and
the page carries a `noindex` meta.

---

## Architecture

There is no build step and no server. `index.html` is the whole frontend; everything else
runs in Supabase:

```
index.html ──auth──▶ Supabase Auth (magic link)
           ──read──▶ public.social_* views (RLS: authenticated only)
           ──POST──▶ /functions/v1/sync-all      (runs the collectors)
           ──POST──▶ /functions/v1/oauth-start   (returns a consent URL)

pg_cron ───daily──▶ sync-all ──▶ sync-youtube │ sync-meta │ sync-tiktok
                                      └──▶ platform APIs ──▶ social.* tables
```

OAuth tokens live in `social.credentials`, which has RLS enabled and zero policies — only
the service role can read it, and the service role never leaves the edge functions.

## Deploying

Pages serves this repo's root directly. No Actions workflow, no Astro — there is nothing
to compile, and a build step here would only add a way for it to break.

1. Create `cunningcorp/portal` on GitHub and push this directory to `main`.
2. **Settings → Pages** → Source: *Deploy from a branch* → `main` / `(root)`.
3. **Settings → Pages → Custom domain** → `portal.cunningcorp.com`. The `CNAME` file is
   already committed. Tick *Enforce HTTPS* once the certificate is issued.
4. DNS: add a `CNAME` record for `portal` pointing at `cunningcorp.github.io`.
5. In Supabase → **Authentication → URL Configuration**, add
   `https://portal.cunningcorp.com` to Redirect URLs. Sign-in fails silently without this.

If this ever grows past one page, port it to Astro the way `aubreynorth` is built and add
the Pages workflow then.

## Security posture

GitHub Pages is always world-readable, so treat the page itself as public. What protects
the data:

- The publishable Supabase key is designed to be public and grants nothing without a session.
- Every `social_*` view requires an authenticated user via RLS.
- `social.credentials` and `social.oauth_states` are unreachable from any client key.
- **Open signups must be off.** Supabase → Authentication → Sign In / Providers → Email →
  disable "Allow new users to sign up", then add users by hand. Without this anyone who
  finds the URL can mint an account and read the numbers.

Never put the service role key in this repo.

## Brand

Palette and type are locked by the Cunning Corp Brand Handbook:

| Role | Token | Hex |
|---|---|---|
| Base · night | Plum | `#241B30` |
| Gradient floor | Plum Deep | `#191220` |
| The light | Gold | `#C8A24C` |
| Highlight | Gold Soft | `#E3C57E` |
| Accent · play | Periwinkle | `#8E8BD8` |
| Light ground | Paper | `#FAF6EE` |

Division accents, one muted tone each: Terracotta `#C0593B` Aubrey North · Slate `#2C3E5D`
Publications · Teal `#1F5F5B` Productions.

Type roles: **Glamour Absolute Extended** wordmark and display · **Recoleta** headings and
figures · **Graphik** body and UI.

Two deliberate departures, both worth knowing about:

1. **Platform colours are data encoding, not brand.** YouTube red, Instagram pink, Facebook
   blue and TikTok cyan appear in the charts and pills because four series on one axis have
   to be told apart at a glance, and four muted house tones cannot do that. They are
   confined to chart strokes and pill fills.
2. **Semantic states borrow from the palette rather than inventing colours.** Positive
   movement uses Gold — the light. Negative uses Terracotta. In-progress uses Periwinkle.
   The handbook's "one glow per layout" rule is held by giving the periwinkle only to the
   primary action.

## Missing fonts

`fonts/` currently holds only `Recoleta-300.woff2`, copied from the aubreynorth repo.
The `@font-face` rules in `index.html` already point at:

```
fonts/GlamourAbsoluteExtended-400.woff2
fonts/GlamourAbsolute-400.woff2
fonts/Graphik-400.woff2
fonts/Graphik-600.woff2
```

Drop those four files in and the page picks them up with no code change — `font-display:
swap` plus a fallback chain means it degrades quietly to Recoleta and a system sans until
then. They are not in either the `aubreynorth` or `cunningcorp` repo; the handbook
references them relatively, so they live wherever the handbook was authored.

## Related

- Schema, collectors and API credential setup: `SETUP.md`
- `supabase/migrations/` and `supabase/functions/` — the deployed schema and collectors, mirrored in-repo
- `CLAUDE.md` — handover brief for the polish pass
