-- Orders module (PORTAL-ORDERS-SPEC). coverage_orders had RLS on with NO policies (anon
-- locked out; rows created only by the submit-coverage-order intake via the service role).
-- The portal shares this project's auth, so add authenticated SELECT (list/read) and UPDATE
-- (status + notes) — exactly the posture as reads_queue. NO INSERT (orders arrive only via
-- the intake function) and NO DELETE (cancel is a status, not a delete — keep the record and
-- the script). The private coverage-scripts bucket keeps zero policies; the file is reached
-- only through the service-role sign-coverage-script function.
create policy "authenticated read orders"
  on public.coverage_orders for select to authenticated using (true);
create policy "authenticated update orders"
  on public.coverage_orders for update to authenticated using (true) with check (true);
