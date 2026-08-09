-- ============================================================================
-- Does 0049 actually refuse a technician? Ask the database. Do not reason about
-- the policy text.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0049_storage_delete_scoping_test.sql
--
-- Everything runs inside a transaction ending in ROLLBACK. Nothing persists —
-- not the seeded objects, not the deletes, not the temporary assignment.
--
-- RUN IT BEFORE APPLYING 0049 AND AFTER.
--
-- Before, every "HOLE OPEN" row must actually read HOLE OPEN. If they do not,
-- this test is not reaching the hole and its silence afterwards proves nothing.
-- A test that only ever runs green cannot tell you what changed — which is how
-- tests/rls/financial-tables.test.ts rotted, asserting toHaveLength(0) against
-- tables it never seeded.
--
-- WHY THE POSITIVE CONTROLS CARRY THE WEIGHT. "Technician deleted 0 rows" is
-- equally consistent with "the policy works" and "the policy denies everyone,
-- including the people who need it". The controls below — technician CAN delete
-- on their own job, office CAN delete anywhere — separate those, and they are
-- the cases most likely to break, because the failure mode 0047 warned about is
-- technicians silently losing their own photos.
--
-- WHY IT PROBES FOUR SURFACES. Scoping storage.objects alone closes nothing:
-- the job_photos row is deletable under the blanket baseline policy, jobs
-- .assigned_to is client-writable so a technician can self-assign, and deleting
-- the job cascades the photo rows away. A test that only probed storage would
-- go green on a fix that leaves the evidence just as destroyable.
--
-- NOTE ON WHAT IS MEASURED. These statements hit storage.objects and the tables
-- directly, which is the same RLS boundary the Storage API and PostgREST
-- enforce, but not the same code path. Deleting a storage.objects row here does
-- not touch the S3 object, and the rollback restores the row regardless.
-- ============================================================================

begin;

create temp table probe(
  surface      text,
  scenario     text,
  expectation  text,
  observed     text,
  rows_hit     int
) on commit drop;

do $$
declare
  tech        uuid;
  office      uuid;
  my_job      uuid;
  other_job   uuid;
  other_photo uuid;
  my_photo    uuid;
  n           int;
  seeded_assignment boolean := false;
  raised      text;
begin
  select id into tech   from profiles where role = 'technician'        limit 1;
  select id into office from profiles where role in ('office','admin') limit 1;

  if tech is null then
    raise exception 'no technician in profiles — this test proves nothing without one';
  end if;
  if office is null then
    raise exception 'no office/admin in profiles — the positive controls cannot run';
  end if;

  -- A job that IS this technician's. Only 5 of 827 jobs carry an assignee in
  -- production, so rather than hope one exists, assign one here. The
  -- transaction rolls back, so nothing outside this test changes — and it makes
  -- the positive controls run every time instead of silently skipping, which is
  -- the entire reason for having them.
  select id into my_job from jobs where assigned_to = tech limit 1;
  if my_job is null then
    select id into my_job from jobs limit 1;
    update jobs set assigned_to = tech where id = my_job;   -- as the migration role, so the trigger allows it
    seeded_assignment := true;
  end if;

  select id into other_job
    from jobs
   where id <> my_job
     and (assigned_to is null or assigned_to <> tech)
   limit 1;
  if other_job is null then
    raise exception 'need a second job that is not assigned to the technician';
  end if;

  -- Seed objects under the real key convention (<jobId>/...), and the matching
  -- metadata rows. Running as the migration role, so RLS does not filter these.
  insert into storage.objects (bucket_id, name, owner)
  values ('job-photos', my_job::text    || '/probe_mine.jpg',      tech),
         ('job-photos', other_job::text || '/probe_theirs.jpg',    office),
         ('job-photos', other_job::text || '/signature_probe.png', office),
         ('job-audio',  other_job::text || '/voice-report.m4a',    office);

  insert into job_photos (job_id, storage_path, uploaded_by, photo_type)
  values (other_job, other_job::text || '/probe_theirs.jpg', office, 'general')
  returning id into other_photo;

  insert into job_photos (job_id, storage_path, uploaded_by, photo_type)
  values (my_job, my_job::text || '/probe_mine.jpg', tech, 'general')
  returning id into my_photo;

  -- =====================================================================
  -- TECHNICIAN
  -- =====================================================================
  perform set_config('request.jwt.claims',
                     json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- 1. THE HOLE ITSELF. Another job's site photo object.
  delete from storage.objects
   where bucket_id = 'job-photos' and name = other_job::text || '/probe_theirs.jpg';
  get diagnostics n = row_count;
  perform set_config('role', 'postgres', true);   -- probe is not writable as authenticated
  insert into probe values ('storage.objects',
    'technician deletes ANOTHER job photo', 'MUST delete 0 rows',
    case when n > 0 then 'HOLE OPEN — DELETED' else 'ok — refused' end, n);
  perform set_config('role', 'authenticated', true);

  -- 2. Another job's customer signature. Same rule, called out separately
  --    because this one is the sign-off record.
  delete from storage.objects
   where bucket_id = 'job-photos' and name = other_job::text || '/signature_probe.png';
  get diagnostics n = row_count;
  perform set_config('role', 'postgres', true);
  insert into probe values ('storage.objects',
    'technician deletes ANOTHER job SIGNATURE', 'MUST delete 0 rows',
    case when n > 0 then 'HOLE OPEN — DELETED' else 'ok — refused' end, n);
  perform set_config('role', 'authenticated', true);

  -- 3. Another job's voice report.
  delete from storage.objects
   where bucket_id = 'job-audio' and name = other_job::text || '/voice-report.m4a';
  get diagnostics n = row_count;
  perform set_config('role', 'postgres', true);
  insert into probe values ('storage.objects',
    'technician deletes ANOTHER job voice report', 'MUST delete 0 rows',
    case when n > 0 then 'HOLE OPEN — DELETED' else 'ok — refused' end, n);
  perform set_config('role', 'authenticated', true);

  -- 4. BYPASS 1 — the metadata row. Even with storage locked, deleting this row
  --    removes the photo from every screen and every report.
  delete from job_photos where id = other_photo;
  get diagnostics n = row_count;
  perform set_config('role', 'postgres', true);
  insert into probe values ('job_photos row',
    'technician deletes ANOTHER job photo ROW', 'MUST delete 0 rows',
    case when n > 0 then 'HOLE OPEN — DELETED' else 'ok — refused' end, n);
  perform set_config('role', 'authenticated', true);

  -- 5. BYPASS 2 — self-assignment. If this succeeds, every scope above is
  --    decorative: assign, destroy, assign back.
  raised := null;
  begin
    update jobs set assigned_to = tech where id = other_job;
    get diagnostics n = row_count;
  exception when others then
    raised := sqlstate;
    n := 0;
  end;
  perform set_config('role', 'postgres', true);
  insert into probe values ('jobs.assigned_to',
    'technician SELF-ASSIGNS another job', 'MUST raise / change 0 rows',
    case when raised is not null then 'ok — refused (' || raised || ')'
         when n > 0 then 'HOLE OPEN — REASSIGNED'
         else 'ok — 0 rows' end, n);
  -- Undo it if it went through, so probes 6+ still test what they claim to.
  update jobs set assigned_to = null where id = other_job and assigned_to = tech;
  perform set_config('role', 'authenticated', true);

  -- 6. BYPASS 3 — the cascade. job_photos.job_id is ON DELETE CASCADE.
  raised := null;
  begin
    delete from jobs where id = other_job;
    get diagnostics n = row_count;
  exception when others then
    raised := sqlstate;
    n := 0;
  end;
  perform set_config('role', 'postgres', true);
  insert into probe values ('jobs',
    'technician DELETES another job (cascades photos)', 'MUST delete 0 rows',
    case when raised is not null then 'ok — refused (' || raised || ')'
         when n > 0 then 'HOLE OPEN — JOB DELETED' else 'ok — refused' end, n);
  perform set_config('role', 'authenticated', true);

  -- 7. POSITIVE CONTROL. Their OWN job's photo object. This is the regression
  --    0047 predicted and refused to risk without a test.
  delete from storage.objects
   where bucket_id = 'job-photos' and name = my_job::text || '/probe_mine.jpg';
  get diagnostics n = row_count;
  perform set_config('role', 'postgres', true);
  insert into probe values ('storage.objects',
    'technician deletes THEIR OWN job photo', 'MUST delete 1 row',
    case when n = 1 then 'ok — allowed' else 'BROKEN — cannot delete own photo' end, n);
  perform set_config('role', 'authenticated', true);

  -- 8. POSITIVE CONTROL. Their OWN job's photo row.
  delete from job_photos where id = my_photo;
  get diagnostics n = row_count;
  perform set_config('role', 'postgres', true);
  insert into probe values ('job_photos row',
    'technician deletes THEIR OWN job photo ROW', 'MUST delete 1 row',
    case when n = 1 then 'ok — allowed' else 'BROKEN — cannot delete own photo row' end, n);

  -- =====================================================================
  -- OFFICE / ADMIN — the load-bearing half. Without these, "technician sees
  -- nothing" is equally consistent with "the bucket is empty".
  -- =====================================================================
  perform set_config('request.jwt.claims',
                     json_build_object('sub', office::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  delete from storage.objects
   where bucket_id = 'job-photos' and name = other_job::text || '/probe_theirs.jpg';
  get diagnostics n = row_count;
  perform set_config('role', 'postgres', true);
  insert into probe values ('storage.objects',
    'office deletes any job photo', 'MUST delete 1 row (0 if probe 1 took it)',
    case when n = 1 then 'ok — allowed'
         when n = 0 then 'INCONCLUSIVE — probe 1 already deleted it, so the hole was open'
         else 'unexpected' end, n);
  perform set_config('role', 'authenticated', true);

  delete from job_photos where id = other_photo;
  get diagnostics n = row_count;
  perform set_config('role', 'postgres', true);
  insert into probe values ('job_photos row',
    'office deletes any job photo ROW', 'MUST delete 1 row (0 if probe 4 took it)',
    case when n = 1 then 'ok — allowed'
         when n = 0 then 'INCONCLUSIVE — probe 4 already deleted it, so the hole was open'
         else 'unexpected' end, n);
  perform set_config('role', 'authenticated', true);

  -- Office must still be able to reassign, or the schedule screen is dead.
  raised := null;
  begin
    update jobs set assigned_to = tech where id = other_job;
    get diagnostics n = row_count;
  exception when others then
    raised := sqlstate;
    n := 0;
  end;
  perform set_config('role', 'postgres', true);
  insert into probe values ('jobs.assigned_to',
    'office REASSIGNS a job', 'MUST change 1 row',
    case when raised is not null then 'BROKEN — office refused (' || raised || ')'
         when n = 1 then 'ok — allowed' else 'BROKEN — 0 rows' end, n);

  -- =====================================================================
  -- SERVER CONTEXT. The assignment trigger fires for EVERY writer, not just
  -- end users — including the service role and plain psql, which carry no JWT
  -- `sub` and so look like "not office/admin". The first version of this
  -- trigger refused them, and CI's own fixture seed
  -- (supabase/ci/seed-roles.sql:111) failed on it. Any backfill, import or
  -- auto-dispatch would have failed the same way.
  -- =====================================================================
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  raised := null;
  begin
    update jobs set assigned_to = tech where id = other_job;
    get diagnostics n = row_count;
  exception when others then
    raised := sqlstate;
    n := 0;
  end;
  insert into probe values ('jobs.assigned_to',
    'SERVICE ROLE assigns a job', 'MUST be allowed — seeds and imports depend on it',
    case when raised is not null then 'BROKEN — server context refused (' || raised || ')'
         when n = 1 then 'ok — allowed' else 'BROKEN — 0 rows' end, n);

  perform set_config('request.jwt.claims', '', true);

  if seeded_assignment then
    raise notice 'no job was assigned to the technician; one was assigned inside this transaction (rolled back)';
  end if;
end;
$$;

select surface, scenario, expectation, observed, rows_hit from probe order by surface, scenario;

rollback;

-- ============================================================================
-- READING THE RESULT
--
--   BEFORE 0049   probes 1-6 read HOLE OPEN (or 'ok — 0 rows' for 5 if the
--                 technician happened to already hold the assignment); 7-8
--                 allowed; office rows INCONCLUSIVE, because the technician
--                 already destroyed the thing the control needed.
--   AFTER  0049   probes 1-6 read "ok — refused"; 7-8 read "ok — allowed";
--                 every office row reads "ok — allowed".
--
-- Any row reading BROKEN means the scope is too tight — a technician has lost
-- their own photos, or office has lost the schedule. Roll back rather than ship.
-- ============================================================================
