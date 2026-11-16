-- ============================================================================
-- Technicians see bookings only on jobs they are on.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-11-16, via SQL editor; gate test passed). Was: paste, then run
-- supabase/tests/0107_technician_bookings_own_jobs_test.sql; trust only its
-- final "0107 PASSED" row.
--
-- WHY (Justin, 16 Nov 2026): technicians may look any job up for its plans,
-- but must not see other people's schedules. job_bookings (0079) was readable
-- by every signed-in user ("using (true)"), so anyone holding the app's anon
-- key could list who is booked where and when across the company. The app now
-- hides it; this makes the database refuse it.
--
-- RULE: office/admin read every booking; anyone else reads the bookings on a
-- job they are on (user_can_manage_job, 0059 — job_assignments, which 0059's
-- triggers keep in step with jobs.assigned_to). So crew on a shared job still
-- see each other's booking there (Justin's choice), and nothing elsewhere.
--
-- Unaffected: the phone's tech_job_bookings stream (already scoped to the
-- technician's jobs), office streams, and service-role routes (calendar sync,
-- reports). Writes stay office/admin (0079). Safe to apply before or after the
-- web/mobile change ships.
--
-- Drops the old SELECT policy by ENUMERATION, never by guessed name (§4 of
-- HANDOVER), and asserts the end state.
-- ============================================================================

do $$
declare
  p record;
begin
  for p in
    select polname from pg_policy
    where polrelid = 'public.job_bookings'::regclass and polcmd = 'r'
  loop
    execute format('drop policy %I on public.job_bookings', p.polname);
  end loop;
end $$;

create policy "job bookings: office, or the crew of the job"
  on public.job_bookings for select to authenticated
  using ((select is_office_or_admin(auth.uid())) or user_can_manage_job(job_id::text));

do $$
declare
  n int;
  q text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.job_bookings'::regclass) then
    raise exception '0107: RLS is off on job_bookings';
  end if;
  select count(*) into n from pg_policy
   where polrelid = 'public.job_bookings'::regclass and polcmd in ('r', '*') and polpermissive;
  if n <> 1 then raise exception '0107: expected 1 permissive SELECT policy on job_bookings, found %', n; end if;
  select pg_get_expr(polqual, polrelid) into q from pg_policy
   where polrelid = 'public.job_bookings'::regclass and polcmd = 'r';
  if position('user_can_manage_job' in q) = 0 then raise exception '0107: SELECT policy is not the crew rule: %', q; end if;
end $$;
