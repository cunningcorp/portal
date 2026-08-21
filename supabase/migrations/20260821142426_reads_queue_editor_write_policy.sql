-- The editor lets the signed-in portal user edit drafts in place. That needs an
-- authenticated UPDATE path on reads_queue, which was service-role-only. Kept tight:
--   * column-scoped GRANT (see the follow-up lockdown migration): the client may edit
--     content + move status, but cannot touch commit_sha / published_at / error.
--   * RLS WITH CHECK pins client-set status to draft|in_review|ready, so the client
--     can never forge publishing/published/failed. Publish stays the edge function's
--     job (service role) -- the only path that makes anything live.
-- No INSERT or DELETE policy for authenticated: drafts are inserted by the drafting
-- engine (service role); the client can only edit what exists.

grant update (
  title, description, tags, target_query, body_markdown, markdown,
  status, suggestions, sources, sources_checked, notes, updated_at
) on public.reads_queue to authenticated;

drop policy if exists reads_queue_authenticated_update on public.reads_queue;
create policy reads_queue_authenticated_update
  on public.reads_queue
  for update
  to authenticated
  using (true)
  with check (status in ('draft','in_review','ready'));
