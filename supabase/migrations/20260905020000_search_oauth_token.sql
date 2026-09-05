-- Search Signal — OAuth token store. The org blocks downloadable service-account keys
-- (iam.managed.disableServiceAccountKeyCreation), so sync-search authenticates to Google
-- via user-consent OAuth (like the YouTube path) instead of a SA key. This singleton row
-- holds the site owner's Search Console refresh token; sync-search mints short-lived access
-- tokens from it. Service-role only — no client ever reads the tokens (RLS on, no policies).
create table if not exists public.search_oauth (
  id           int primary key default 1 check (id = 1),
  refresh_token text,
  access_token  text,
  expires_at    timestamptz,
  scopes        text[],
  updated_at    timestamptz not null default now()
);
alter table public.search_oauth enable row level security;
