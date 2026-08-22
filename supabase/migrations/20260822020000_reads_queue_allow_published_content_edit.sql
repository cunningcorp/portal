-- Published-edit (design package doc 03, B1). Let the authenticated client UPDATE the
-- content columns of a row that is ALREADY published (an urgent tweak → "Update live"),
-- without letting it forge a publish on a non-published row.
--
-- The live policy had WITH CHECK (status in draft|in_review|ready), which rejected any
-- update whose resulting row is 'published' — so a published Read could not be edited at
-- all. We widen WITH CHECK to also allow status='published', but ONLY when the row was
-- already published (a subquery tied to the pre-update status). So:
--   * editing a published row (status stays 'published')      → allowed
--   * forging a draft/ready row directly to 'published'       → rejected (prev status ≠ published)
--   * the normal draft → in_review → ready path               → unchanged
--
-- published_at / commit_sha remain outside the column-scoped UPDATE grant, so the client
-- still cannot fabricate a publish record; the real re-publish is done server-side by
-- publish-read (service role). USING stays `true` (it already admitted published rows).
drop policy if exists reads_queue_authenticated_update on public.reads_queue;
create policy reads_queue_authenticated_update
  on public.reads_queue
  for update
  to authenticated
  using (true)
  with check (
    status in ('draft', 'in_review', 'ready')
    or (
      status = 'published'
      and exists (
        select 1 from public.reads_queue prev
        where prev.id = public.reads_queue.id and prev.status = 'published'
      )
    )
  );
