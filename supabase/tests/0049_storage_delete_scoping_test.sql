-- ============================================================================
-- Does 0049 actually refuse a technician? Ask the database. Do not reason about
-- the policy text.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0049_storage_delete_scoping_test.sql
--
-- Everything runs inside a transaction ending in ROLLBACK. Nothing persists —
-- not the seeded objects, not the deletes, not the temporary assignment.
--
-- RUN IT BEFORE APPLYING 0049 AND AFTER. Before, the bypass probes must read
-- HOLE OPEN. If they do not, this test is not reaching the hole and its silence
-- afterwards proves nothing. A test that has only ever run green cannot tell
-- you what changed — which is how tests/rls/financial-tables.test.ts rotted,
-- asserting toHaveLength(0) against tables it never seeded.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS CAN AND CANNOT REACH, AND WHY
-- ---------------------------------------------------------------------------
-- It cannot delete a storage object. Supabase installs a trigger that refuses
-- every direct SQL delete on storage.objects:
--
--   ERROR: Direct deletion from storage tables is not allowed. Use the Storage
--          API instead.
--   CONTEXT: PL/pgSQL function storage.protect_delete()
--
-- That is an operational guard against orphaning files, not a security
-- boundary, and it fires before RLS is observable — so "technician deletes a
-- foreign object" is simply not expressible in SQL. Working around it means
-- disabling triggers (session_replication_role, superuser-only, and it would
-- also disable the assignment trigger this same test is checking). Not worth
-- trading a real test for a fragile one.
--
-- So the storage half is tested at the DECISION, not the effect: under real
-- impersonation, user_can_manage_job() — the single predicate all four storage
-- policies wrap, and which migration 0049 asserts they reference — must be
-- false for a foreign job and true for the technician's own. If that function
-- answers correctly and the policies call it, the policies discriminate
-- correctly.
--
-- What that leaves unproven is the wiring between the Storage API and those
-- policies. Close it by hand, once, after applying, from a real technician
-- session:
--
--   supabase.storage.from('job-photos').remove([<a foreign job's key>])
--
-- and confirm the object is still listed. Note the API returns HTTP 200 with an
-- EMPTY ARRAY when RLS filters the delete — it does not error — so inspect
-- `data`, not just `error`.
--
-- The bypass probes below ARE fully exercised here: job_photos rows, the jobs
-- cascade and jobs.assigned_to are ordinary tables with no such guard, and they
-- are where scoping storage alone would have left the evidence destroyable.
--
-- WHY THE POSITIVE CONTROLS CARRY THE WEIGHT. "Technician got 0" is equally
-- consistent with "the policy works" and "the policy denies everyone, including
-- the people who need it". The controls — technician CAN act on their own job,
-- office CAN act anywhere, the SERVER can still assign — separate those, and
-- they are the cases most likely to break.
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
  ok          boolean;
  raised      text;
  seeded_assignment boolean := false;
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
  -- production, so rather than hope one exists, assign one here. Rolled back.
  select id into my_job from jobs where assigned_to = tech limit 1;
  if my_job is null then
    select id into my_job from jobs limit 1;
    update jobs set assigned_to = tech where id = my_job;
    seeded_assignment := true;
  end if;

  -- A job that is NOT theirs. CI's fixture holds exactly ONE job, deliberately
  -- assigned to the technician, so this creates the second rather than raising.
  -- customer_id and title are the only NOT NULL columns without a default
  -- (0000_baseline.sql:109,113).
  select id into other_job
    from jobs
   where id <> my_job and (assigned_to is null or assigned_to <> tech)
   limit 1;
  if other_job is null then
    insert into jobs (customer_id, site_id, title)
    select customer_id, site_id, 'S4 probe — job not assigned to the technician'
      from jobs where id = my_job
    returning id into other_job;
  end if;

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

  -- 1. THE STORAGE DECISION, for a job that is not theirs. Every job-photos and
  --    job-audio DELETE/UPDATE policy is a wrapper around this call.
  ok := user_can_manage_job(other_job::text);
  perform set_config('role', 'postgres', true);   -- probe is not writable as authenticated
  insert into probe values ('storage predicate',
    'technician may manage ANOTHER job''s media', 'MUST be false',
    case when ok then 'HOLE OPEN — permitted' else 'ok — refused' end,
    case when ok then 1 else 0 end);
  perform set_config('role', 'authenticated', true);

  -- 2. POSITIVE CONTROL for the same predicate. If this is false the scope is
  --    too tight and technicians have lost their own photos — the exact
  --    regression 0047 refused to risk without a test.
  ok := user_can_manage_job(my_job::text);
  perform set_config('role', 'postgres', true);
  insert into probe values ('storage predicate',
    'technician may manage THEIR OWN job''s media', 'MUST be true',
    case when ok then 'ok — allowed' else 'BROKEN — cannot manage own media' end,
    case when ok then 1 else 0 end);
  perform set_config('role', 'authenticated', true);

  -- 3. A key naming no job at all — the 6 orphans measured in production. Must
  --    not be manageable by a technician, and must not raise (the predicate
  --    compares j.id::text rather than casting the path to uuid precisely so a
  --    non-uuid segment fails to match instead of aborting the statement).
  raised := null;
  begin
    ok := user_can_manage_job('not-a-uuid');
  exception when others then
    raised := sqlstate;
    ok := true;
  end;
  perform set_config('role', 'postgres', true);
  insert into probe values ('storage predicate',
    'technician may manage an ORPHAN key', 'MUST be false, and MUST NOT raise',
    case when raised is not null then 'BROKEN — raised ' || raised
         when ok then 'HOLE OPEN — permitted' else 'ok — refused' end,
    case when ok then 1 else 0 end);
  perform set_config('role', 'authenticated', true);

  -- 4. BYPASS 1 — the metadata row. Even with storage locked, deleting this
  --    removes the photo from every screen and every report.
  delete from job_photos where id = other_photo;
  get diagnostics n = row_count;
  perform set_config('role', 'postgres', true);
  insert into probe values ('job_photos row',
    'technician deletes ANOTHER job photo ROW', 'MUST delete 0 rows',
    case when n > 0 then 'HOLE OPEN — DELETED' else 'ok — refused' end, n);
  perform set_config('role', 'authenticated', true);

  -- 5. BYPASS 2 — self-assignment. If this succeeds every scope above is
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
  -- Undo it if it went through. Claims are cleared first, not just the DB role:
  -- the trigger keys on auth.role(), which reads the JWT, so with the
  -- technician's claims still set this undo would itself be refused and abort
  -- the run. Post-migration the WHERE matches nothing anyway — but a test that
  -- works only because the thing it tests works is not a test.
  perform set_config('request.jwt.claims', '', true);
  update jobs set assigned_to = null where id = other_job and assigned_to = tech;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
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

  -- 7. POSITIVE CONTROL. Their OWN job's photo row.
  delete from job_photos where id = my_photo;
  get diagnostics n = row_count;
  perform set_config('role', 'postgres', true);
  insert into probe values ('job_photos row',
    'technician deletes THEIR OWN job photo ROW', 'MUST delete 1 row',
    case when n = 1 then 'ok — allowed' else 'BROKEN — cannot delete own photo row' end, n);

  -- =====================================================================
  -- OFFICE / ADMIN — the load-bearing half. Without these, "technician is
  -- refused" is equally consistent with "everyone is refused".
  -- =====================================================================
  perform set_config('request.jwt.claims',
                     json_build_object('sub', office::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  ok := user_can_manage_job(other_job::text);
  perform set_config('role', 'postgres', true);
  insert into probe values ('storage predicate',
    'office may manage ANY job''s media', 'MUST be true',
    case when ok then 'ok — allowed' else 'BROKEN — office locked out' end,
    case when ok then 1 else 0 end);
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
  -- SERVER CONTEXT. The assignment trigger fires for EVERY writer, including
  -- the service role and plain psql, which carry no JWT `sub`. The first
  -- version refused them and CI's own fixture seed
  -- (supabase/ci/seed-roles.sql:111) failed on it; so would any backfill,
  -- import or auto-dispatch.
  -- =====================================================================
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  raised := null;
  begin
    update jobs set assigned_to = office where id = other_job;
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

-- ---------------------------------------------------------------------------
-- MAKE IT A GATE, NOT A PRINTOUT.
--
-- CI runs every supabase/tests/*.sql with ON_ERROR_STOP=1 (.github/workflows/
-- ci.yml:221-223), so a RAISE fails the build but a table of results does not.
-- Without this a probe could read HOLE OPEN and the job would still go green —
-- the boundary documented rather than enforced.
--
-- Every probe seeds its own fixtures, so this is deterministic against a freshly
-- migrated database. It is EXPECTED TO FAIL where 0049 has not been applied.
-- That is the point, and it is what makes the before/after run mean something.
-- ---------------------------------------------------------------------------
do $$
declare
  bad text;
begin
  select string_agg(format('%s / %s -> %s', surface, scenario, observed), E'\n  ')
    into bad
  from probe
  where observed not like 'ok%';

  if bad is not null then
    raise exception E'0049 boundary NOT in force:\n  %', bad;
  end if;
end;
$$;

rollback;
