-- Learning loop — capture trigger (LEARNING-LOOP-SPEC Part 1).
--
-- Records one read_edits row automatically whenever a Read transitions to 'published',
-- capturing the frozen AI draft (original_markdown) against what actually shipped (markdown),
-- with the publish commit. Deliberately a TRIGGER rather than a line in publish-read: capture
-- is then fully decoupled from the critical publish path — it can never make a publish fail,
-- and it also covers any future publish path, not just today's function. Silent and always-on;
-- Demetri does nothing extra.
--
-- The row stores BOTH full texts plus a lightweight diff (changed flag + lengths). The
-- structured hunks and the Part 4 edit-weight metric are computed by the weekly learning pass
-- from the stored texts — that clustering/analysis is the pass's job, not the trigger's, and
-- keeping the heavy diff out of the hot path is deliberate.

create or replace function public.capture_read_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  orig text := coalesce(NEW.original_markdown, NEW.markdown);
begin
  insert into public.read_edits
    (slug, queue_id, lane, commit_sha, original_markdown, final_markdown, diff, suggestions)
  values (
    NEW.slug, NEW.id, NEW.lane, NEW.commit_sha,
    orig, NEW.markdown,
    jsonb_build_object(
      'changed',         (coalesce(NEW.original_markdown, '') is distinct from coalesce(NEW.markdown, '')),
      'original_length', coalesce(length(orig), 0),
      'final_length',    coalesce(length(NEW.markdown), 0),
      'length_delta',    coalesce(length(NEW.markdown), 0) - coalesce(length(orig), 0),
      'has_frozen_original', (NEW.original_markdown is not null),
      'note',            case when NEW.original_markdown is null
                              then 'pre-learning-loop draft: no frozen original, diff is empty by construction'
                              else 'structured hunks + edit-weight computed by the learning pass from the stored texts' end
    ),
    coalesce(NEW.suggestions, '[]'::jsonb)
  );
  return NEW;
end;
$$;

-- Fire only on the transition INTO 'published' (first publish and each "Update live"). An
-- update that leaves status alone, or the ready->publishing claim, does not fire.
drop trigger if exists reads_queue_capture_edit on public.reads_queue;
create trigger reads_queue_capture_edit
  after update of status on public.reads_queue
  for each row
  when (NEW.status = 'published' and OLD.status is distinct from 'published')
  execute function public.capture_read_edit();

-- The function is SECURITY DEFINER; being in public it would otherwise be exposed as an RPC
-- (/rest/v1/rpc/capture_read_edit) to anon/authenticated. A trigger fires without EXECUTE, so
-- revoke it from every client role — the function stays invocable ONLY by the trigger.
revoke execute on function public.capture_read_edit() from public, anon, authenticated;
