-- Short-lived CSRF state for the connect flows. Service-role only.
create table if not exists social.oauth_states (
  state       text primary key,
  platform    text not null,
  redirect_to text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '15 minutes',
  consumed_at timestamptz
);

create index if not exists idx_oauth_states_expiry on social.oauth_states (expires_at);

alter table social.oauth_states enable row level security;
-- No policies: reachable only by service_role.

comment on table social.oauth_states is 'CSRF state tokens for platform OAuth connect flows. Expire after 15 minutes.';
