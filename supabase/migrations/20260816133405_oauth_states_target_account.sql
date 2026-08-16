-- Which account a connect flow is for, when the provider cannot tell us.
--
-- YouTube needs this. Discovering the channel used to mean channels.list?mine=true,
-- which requires the sensitive youtube.readonly scope. Now that the app requests only
-- yt-analytics.readonly, there is no endpoint that answers "which channel just
-- consented" -- the Analytics API reports on a channel you name, it does not name one
-- for you. So the caller states the target up front and the callback verifies that the
-- authenticated identity can actually read that channel's analytics before storing
-- anything.
--
-- Being explicit is better than the old guesswork regardless: with Brand Accounts, the
-- Google account chooser decides which channel you get, and picking the wrong entry
-- silently reconnected the channel you already had.

alter table social.oauth_states
  add column if not exists account_id uuid references social.accounts(id) on delete cascade;

comment on column social.oauth_states.account_id is
  'Target account for flows where the provider cannot identify it. Required for YouTube.';
