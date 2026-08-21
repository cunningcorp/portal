-- Social panel (PORTAL-SOCIAL-SPEC / design package doc 02, W1). The generated per-Read
-- social pack lives in one additive jsonb column, mirroring the suggestions/sources pattern
-- already on reads_queue. The panel (authenticated client) reads/writes it; generate-social
-- (service role) populates it on demand. No new status values; publish path untouched.
alter table public.reads_queue
  add column if not exists social jsonb default '{}';

-- Extend the authenticated, column-scoped UPDATE grant to include `social`, so the editor
-- client can persist edits and the manual per-channel state tracker (generated → copied →
-- posted). Grants are additive, so this only adds `social` to the set granted in
-- 20260821142622_reads_queue_column_update_lockdown.sql. RLS WITH CHECK is unchanged
-- (client-set status stays pinned to draft|in_review|ready), no INSERT/DELETE is added, and
-- the publish record (commit_sha, published_at, error) stays physically un-writable by the
-- client.
grant update (social) on public.reads_queue to authenticated;
