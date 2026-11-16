-- ============================================================================
-- GATE TEST for 0107 — technicians read bookings only on jobs they are on.
--
--   paste into the Supabase SQL editor after 0107 (or psql -f).
--
-- ONE DO BLOCK, SELF-UNDOING (see the 0073 test's header). Checks the policy
-- shape, then impersonates a real active technician inside the block and
-- counts what they can read: zero bookings on jobs they are not on, and every
-- booking on a job they are on. If the database has no technician with a
-- booking elsewhere, the impersonation half says so and the shape checks stand.
-- Ends with a SELECT so a rolled-back run shows a red error, never a quiet
-- notice.
-- ============================================================================

do $$
declare
  n int;
  failures text := '';
  tech uuid;
  others int;
  seen_others int;
  own int;
  seen_own int;
begin
  select count(*) into n from pg_policy
   where polrelid = 'public.job_bookings'::regclass and polcmd in ('r', '*') and polpermissive;
  if n <> 1 then failures := failures || format('expected 1 SELECT policy, found %s; ', n); end if;
  if exists (select 1 from pg_policy where polrelid = 'public.job_bookings'::regclass
               and polcmd = 'r' and pg_get_expr(polqual, polrelid) = 'true') then
    failures := failures || 'a using(true) SELECT policy is still there; ';
  end if;
  if has_table_privilege('anon', 'public.job_bookings', 'select')
     and exists (select 1 from pg_policy where polrelid = 'public.job_bookings'::regclass and 'anon'::regrole::oid = any(polroles)) then
    failures := failures || 'anon has a policy; ';
  end if;

  -- A technician who has bookings on someone else's job to (not) see.
  select p.id into tech
    from profiles p
   where p.role = 'technician' and p.is_active is not false
     and exists (select 1 from job_bookings b
                  where not exists (select 1 from job_assignments a where a.job_id = b.job_id and a.staff_id = p.id))
   limit 1;

  if tech is not null then
    select count(*) into others from job_bookings b
     where not exists (select 1 from job_assignments a where a.job_id = b.job_id and a.staff_id = tech);
    select count(*) into own from job_bookings b
     where exists (select 1 from job_assignments a where a.job_id = b.job_id and a.staff_id = tech);

    begin
      perform set_config('request.jwt.claims', json_build_object('sub', tech, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      select count(*) into seen_others from job_bookings b
       where not exists (select 1 from job_assignments a where a.job_id = b.job_id and a.staff_id = tech);
      select count(*) into seen_own from job_bookings b
       where b.job_id in (select a.job_id from job_assignments a where a.staff_id = tech);
      execute 'reset role';
    exception when others then
      execute 'reset role';
      failures := failures || 'impersonation failed: ' || sqlerrm || '; ';
    end;

    if seen_others is not null and seen_others <> 0 then
      failures := failures || format('technician sees %s of %s bookings on other jobs; ', seen_others, others);
    end if;
    if seen_own is not null and seen_own <> own then
      failures := failures || format('technician sees %s of %s bookings on their own jobs; ', seen_own, own);
    end if;
  else
    raise notice '0107: no technician with bookings elsewhere — impersonation skipped';
  end if;

  if failures <> '' then raise exception '0107 gate FAILED: %', failures; end if;
end $$;

select '0107 PASSED' as result;
