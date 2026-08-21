-- Supabase grants authenticated/anon a table-wide UPDATE by default (gated by RLS).
-- That table-wide grant overrode the column-scoped one from the previous migration,
-- so the client could still write commit_sha/published_at. Revoke the table-wide
-- UPDATE and re-grant only the editable columns, so the publish record (commit_sha,
-- published_at, error) is physically un-writable by the client, on top of the RLS
-- status guard.

revoke update on public.reads_queue from authenticated;
revoke update on public.reads_queue from anon;

grant update (
  title, description, tags, target_query, body_markdown, markdown,
  status, suggestions, sources, sources_checked, notes, updated_at
) on public.reads_queue to authenticated;
