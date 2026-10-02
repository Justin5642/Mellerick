-- ============================================================================
-- Does 0059 actually let a crew share a job, and refuse a technician who tries
-- to assign one? Ask the database.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0059_job_assignments_test.sql
--
-- Everything runs inside a transaction ending in ROLLBACK. Nothing persists.
--
-- The CI fixture (supabase/ci/seed-roles.sql) seeds exactly one technician, so
-- this creates a second (and a third, uninvolved one) inside its own rolled-
-- back transaction rather than depending on a fixture change.
--
-- WHAT THIS PROVES, AND WHY EACH PART MATTERS
--   * Writing jobs.assigned_to directly still works and still populates
--     job_assignments (collapse_job_assignments_on_direct_write) -- the path
--     every unmigrated caller (old mobile builds, create-job form, CI seeds)
--     still uses.
--   * Adding a SECOND assignee does not steal the primary slot from the
--     first -- jobs.assigned_to must keep pointing at whoever was added
--     first, or every "my jobs" read keyed on that column loses the
--     original technician the moment a crew job is created.
--   * user_can_manage_job() -- the predicate 4 storage policies and 1
--     job_photos policy wrap -- must be true for a SECONDARY assignee, not
--     just jobs.assigned_to. This is the actual point of the migration:
--     before it, a co-assigned technician could not touch their own job's
--     photos.
--   * Only office/admin may write job_assignments, by hand or through
--     set_job_assignments -- a technician granting themselves (or anyone
--     else) a job must be refused, not silently ignored, or the office
--     schedule screen would appear to work for a technician who opened it by
--     URL.
--   * Removing an assignee via set_job_assignments down to one person
--     recomputes jobs.assigned_to to the one who is left.
--   * Reassigning via a direct `update jobs set assigned_to` on a job that
--     currently has a crew collapses job_assignments back to that one person
--     -- the documented, intentional behavior for any caller not yet using
--     the join table, not a bug.
--
-- The two triggers' convergence (no ping-pong) is not a separate probe: an
-- actual infinite loop between them would blow PL/pgSQL's stack and abort
-- this entire script with "stack depth limit exceeded" rather than let any
-- probe below run. Reaching the final gate at all is part of what this test
-- proves.
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
  tech1       uuid := '11111111-1111-1111-1111-111111111111'; -- CI Technician (seed-roles.sql)
  tech2       uuid := 'eeeeeeee-1111-1111-1111-000000000002'; -- second crew member, seeded below
  tech3       uuid := 'eeeeeeee-1111-1111-1111-000000000003'; -- uninvolved technician, seeded below
  office      uuid;
  job_a       uuid := 'eeeeeeee-0000-0000-0000-000000000059';
  n           int;
  ok          boolean;
  raised      text;
  result_set  uuid[];
begin
  select id into office from profiles where role in ('office','admin') limit 1;
  if office is null then
    raise exception 'no office/admin in profiles — the positive controls cannot run';
  end if;

  -- Seed the two extra technicians under service-role claims, same reason
  -- seed-roles.sql does: 0044's role-change trigger only accepts admin or
  -- the service role.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
  values
    (tech2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ci-tech2@test.local', crypt('ci-password-2x', gen_salt('bf')), now(), now(), now()),
    (tech3, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ci-tech3@test.local', crypt('ci-password-3x', gen_salt('bf')), now(), now(), now())
  on conflict (id) do nothing;

  insert into profiles (id, full_name, email, role, is_active)
  values
    (tech2, 'CI Technician 2', 'ci-tech2@test.local', 'technician', true),
    (tech3, 'CI Technician 3', 'ci-tech3@test.local', 'technician', true)
  on conflict (id) do update set role = excluded.role, is_active = true;
  perform set_config('request.jwt.claims', '', true);

  -- A job, assigned directly (no role claims set — same as seed-roles.sql's
  -- own job insert) so the INSERT trigger on jobs populates job_assignments.
  insert into jobs (id, customer_id, site_id, assigned_to, title)
  values (job_a, 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', tech1, 'S59 probe — crew job')
  on conflict (id) do update set assigned_to = tech1;

  -- =====================================================================
  -- 1. A direct assigned_to write populates job_assignments.
  -- =====================================================================
  select count(*) into n from job_assignments where job_id = job_a and staff_id = tech1;
  insert into probe values ('job_assignments',
    'direct jobs.assigned_to write populates the join table', 'MUST be exactly 1 row',
    case when n = 1 then 'ok — 1 row' else 'BROKEN — ' || n || ' rows' end, n);

  -- =====================================================================
  -- 2. OFFICE adds a second assignee directly. Must succeed, and must NOT
  --    steal the primary slot from tech1.
  -- =====================================================================
  perform set_config('request.jwt.claims',
                     json_build_object('sub', office::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  insert into job_assignments (job_id, staff_id, assigned_by) values (job_a, tech2, office);
  get diagnostics n = row_count;
  perform set_config('role', 'postgres', true);
  insert into probe values ('job_assignments',
    'office adds a SECOND assignee to a job', 'MUST insert 1 row',
    case when n = 1 then 'ok — allowed' else 'BROKEN — 0 rows' end, n);
  perform set_config('role', 'authenticated', true);

  perform set_config('role', 'postgres', true);
  select (assigned_to = tech1) into ok from jobs where id = job_a;
  insert into probe values ('jobs.assigned_to',
    'primary stays tech1 after a second assignee is added', 'MUST still be tech1',
    case when ok then 'ok — unchanged' else 'BROKEN — primary slot stolen' end,
    case when ok then 1 else 0 end);
  perform set_config('role', 'authenticated', true);

  -- =====================================================================
  -- 3. TECHNICIAN cannot assign a job — neither themselves nor anyone else.
  -- =====================================================================
  perform set_config('request.jwt.claims',
                     json_build_object('sub', tech1::text, 'role', 'authenticated')::text, true);
  raised := null;
  begin
    insert into job_assignments (job_id, staff_id) values (job_a, tech3);
    get diagnostics n = row_count;
  exception when others then
    raised := sqlstate;
    n := 0;
  end;
  perform set_config('role', 'postgres', true);
  insert into probe values ('job_assignments',
    'technician assigns ANOTHER technician to their own job', 'MUST raise / insert 0 rows',
    case when raised is not null then 'ok — refused (' || raised || ')'
         when n > 0 then 'HOLE OPEN — INSERTED' else 'ok — 0 rows' end, n);
  perform set_config('role', 'authenticated', true);

  -- 4. TECHNICIAN cannot remove a co-assignee either (DELETE is RLS-filtered,
  --    not raised — same silent-filter shape as 0049's bypass probes).
  delete from job_assignments where job_id = job_a and staff_id = tech2;
  get diagnostics n = row_count;
  perform set_config('role', 'postgres', true);
  insert into probe values ('job_assignments',
    'technician removes a CO-ASSIGNEE from their own job', 'MUST delete 0 rows',
    case when n > 0 then 'HOLE OPEN — DELETED' else 'ok — refused' end, n);
  perform set_config('role', 'authenticated', true);

  -- =====================================================================
  -- 5. user_can_manage_job() — the actual point of this migration. True for
  --    a SECONDARY assignee, false for someone not on the job at all.
  -- =====================================================================
  perform set_config('request.jwt.claims',
                     json_build_object('sub', tech2::text, 'role', 'authenticated')::text, true);
  ok := user_can_manage_job(job_a::text);
  perform set_config('role', 'postgres', true);
  insert into probe values ('user_can_manage_job',
    'SECONDARY assignee may manage their job''s media', 'MUST be true',
    case when ok then 'ok — allowed' else 'BROKEN — secondary assignee locked out' end,
    case when ok then 1 else 0 end);
  perform set_config('role', 'authenticated', true);

  perform set_config('request.jwt.claims',
                     json_build_object('sub', tech3::text, 'role', 'authenticated')::text, true);
  ok := user_can_manage_job(job_a::text);
  perform set_config('role', 'postgres', true);
  insert into probe values ('user_can_manage_job',
    'UNINVOLVED technician may manage the job', 'MUST be false',
    case when ok then 'HOLE OPEN — permitted' else 'ok — refused' end,
    case when ok then 1 else 0 end);
  perform set_config('role', 'authenticated', true);

  -- =====================================================================
  -- 6. set_job_assignments — the atomic multi-assignee write. Office
  --    replaces the set; a technician calling it changes nothing.
  -- =====================================================================
  perform set_config('request.jwt.claims',
                     json_build_object('sub', office::text, 'role', 'authenticated')::text, true);
  select array_agg(staff_id order by staff_id) into result_set
    from set_job_assignments(job_a, array[tech1, tech2]::uuid[]);
  perform set_config('role', 'postgres', true);
  select count(*) into n from job_assignments where job_id = job_a;
  insert into probe values ('set_job_assignments',
    'office replaces the set with {tech1, tech2}', 'MUST be exactly those 2',
    case when result_set = array[least(tech1,tech2), greatest(tech1,tech2)] and n = 2
         then 'ok — {tech1, tech2}'
         else 'BROKEN — got ' || coalesce(result_set::text, 'null') || ' (' || n || ' rows)' end,
    n);
  perform set_config('role', 'authenticated', true);

  -- Shrink the set to {tech2} alone — the primary must move to tech2.
  perform set_job_assignments(job_a, array[tech2]::uuid[]);
  perform set_config('role', 'postgres', true);
  select (assigned_to = tech2) into ok from jobs where id = job_a;
  insert into probe values ('jobs.assigned_to',
    'primary recomputes to tech2 once tech1 is removed via the RPC', 'MUST be tech2',
    case when ok then 'ok — tech2' else 'BROKEN — primary did not move' end,
    case when ok then 1 else 0 end);
  perform set_config('role', 'authenticated', true);

  -- Rebuild {tech1, tech2} for the next probe.
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', office::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform set_job_assignments(job_a, array[tech1, tech2]::uuid[]);

  -- A technician calling the RPC to add themselves as a THIRD assignee: the
  -- function's own insert hits job_assignments' RLS and must raise, leaving
  -- the set unchanged.
  perform set_config('request.jwt.claims',
                     json_build_object('sub', tech1::text, 'role', 'authenticated')::text, true);
  raised := null;
  begin
    perform set_job_assignments(job_a, array[tech1, tech2, tech3]::uuid[]);
  exception when others then
    raised := sqlstate;
  end;
  perform set_config('role', 'postgres', true);
  select count(*) into n from job_assignments where job_id = job_a and staff_id = tech3;
  insert into probe values ('set_job_assignments',
    'technician uses the RPC to add a THIRD assignee', 'MUST raise / add 0 rows',
    case when raised is not null then 'ok — refused (' || raised || ')'
         when n > 0 then 'HOLE OPEN — ADDED' else 'ok — 0 rows' end, n);
  perform set_config('role', 'authenticated', true);

  -- =====================================================================
  -- 7. A direct assigned_to write collapses a crew job back to one person —
  --    documented, intentional behavior for any caller not using the join
  --    table (old mobile builds, the single-assignee create-job form).
  -- =====================================================================
  perform set_config('request.jwt.claims',
                     json_build_object('sub', office::text, 'role', 'authenticated')::text, true);
  update jobs set assigned_to = tech3 where id = job_a;
  perform set_config('role', 'postgres', true);
  select count(*) into n from job_assignments where job_id = job_a;
  insert into probe values ('job_assignments',
    'a direct assigned_to write collapses a 2-person crew to 1', 'MUST be exactly 1 row (tech3)',
    case when n = 1 then
      case when exists (select 1 from job_assignments where job_id = job_a and staff_id = tech3)
           then 'ok — collapsed to tech3' else 'BROKEN — collapsed to the wrong person' end
    else 'BROKEN — ' || n || ' rows' end, n);
end;
$$;

select surface, scenario, expectation, observed, rows_hit from probe order by surface, scenario;

-- ---------------------------------------------------------------------------
-- MAKE IT A GATE, NOT A PRINTOUT. Same discipline as 0049's test — CI runs
-- every supabase/tests/*.sql with ON_ERROR_STOP=1.
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
    raise exception E'0059 job_assignments NOT in force:\n  %', bad;
  end if;
end;
$$;

rollback;
