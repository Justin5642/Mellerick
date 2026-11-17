-- ============================================================================
-- GATE TEST for 0110 — limited-access accounts see only the jobs they are on.
--
--   paste the whole file into the Supabase SQL editor (after 0110), or
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0110_limited_access_accounts_test.sql
--
-- Trust ONLY a final row reading "0110 PASSED". Any failure raises, the whole
-- paste rolls back, and the editor shows a red error naming each failing
-- scenario.
--
-- ONE DO BLOCK, SELF-UNDOING (pattern: header of 0073_deactivation_test.sql).
-- The fixture changes and scenarios sit in an inner block that ends by raising
-- a private SQLSTATE, which rolls that inner block back; the results — kept in
-- a local variable, which survives the rollback — are checked afterwards.
-- Nothing is inserted into jobs (that would burn a job number); the test
-- borrows an existing active technician who is on at least one job, flips
-- their flag inside the rolled-back block, and adds one backflow device only
-- if the register is empty (so "sees zero devices" can't pass vacuously).
--
-- Both halves are tested: the limited account is narrowed, AND the same
-- technician with the flag off sees exactly what they saw before, AND an
-- office/admin user is untouched — or real staff would lose data silently.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  adm  uuid;
  off  uuid;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
  -- ground truth, counted as postgres (RLS not applied)
  all_jobs int; my_jobs int; my_customers int; my_sites int;
  all_devices int; all_tests int; my_notes int; my_photo_rows int;
  my_po int; other_files int;
  -- what the technician sees
  before_jobs int; before_customers int; before_sites int; before_devices int; before_tests int; before_notes int;
  n int;
begin
  -- A function body would hide a missing column behind a confusing error;
  -- say it plainly instead.
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles' and column_name = 'limited_access') then
    raise exception '0110 is not applied: profiles.limited_access does not exist';
  end if;

  begin
    -- An active technician, not already limited, on at least one job, with
    -- other jobs they are NOT on (otherwise "sees only their jobs" is vacuous).
    select p.id into tech
      from profiles p
     where p.role = 'technician' and coalesce(p.is_active, true) and not p.limited_access
       and exists (select 1 from job_assignments ja where ja.staff_id = p.id)
     order by (select count(*) from job_assignments ja where ja.staff_id = p.id) desc
     limit 1;
    select id into adm from profiles where role = 'admin' and coalesce(is_active, true) limit 1;
    select id into off from profiles where role in ('office', 'admin') and coalesce(is_active, true)
      order by (role = 'office') desc limit 1;
    if tech is null or adm is null or off is null then
      raise exception 'fixture missing: need an active technician on at least one job, and an active admin';
    end if;

    -- Ground truth, as postgres.
    select count(*) into all_jobs from jobs;
    select count(distinct ja.job_id) into my_jobs from job_assignments ja where ja.staff_id = tech;
    if all_jobs <= my_jobs then
      raise exception 'fixture missing: every job is assigned to the chosen technician, nothing to hide';
    end if;
    select count(distinct j.customer_id) into my_customers
      from jobs j where j.id in (select job_id from job_assignments where staff_id = tech);
    select count(distinct j.site_id) into my_sites
      from jobs j where j.site_id is not null and j.id in (select job_id from job_assignments where staff_id = tech);
    select count(*) into my_notes
      from job_notes where job_id in (select job_id from job_assignments where staff_id = tech);
    select count(*) into my_photo_rows
      from job_photos where job_id in (select job_id from job_assignments where staff_id = tech);
    select count(*) into my_po
      from purchase_orders where job_id in (select job_id from job_assignments where staff_id = tech);

    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    if not exists (select 1 from backflow_devices) then
      insert into backflow_devices (customer_id, water_authority, device_type)
      select id, 'yarra_valley_water', 'rpzd' from customers limit 1;
    end if;
    select count(*) into all_devices from backflow_devices;
    select count(*) into all_tests from backflow_tests;

    -- 1. The technician, UNLIMITED, before anything changes.
    perform set_config('request.jwt.claims',
                       json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into before_jobs from jobs;
    select count(*) into before_customers from customers;
    select count(*) into before_sites from sites;
    select count(*) into before_devices from backflow_devices;
    select count(*) into before_tests from backflow_tests;
    select count(*) into before_notes from job_notes;
    perform set_config('role', 'postgres', true);
    res := res || format('unlimited technician sees every job|%s|%s', all_jobs, before_jobs);
    res := res || format('unlimited technician sees every backflow device|%s|%s', all_devices, before_devices);

    -- 2. THE ATTACK: an unlimited technician cannot flip their own flag
    --    (nor a limited one clear it — scenario 5).
    perform set_config('role', 'authenticated', true);
    begin
      update profiles set limited_access = true where id = tech;
      perform set_config('role', 'postgres', true);
      outcome := 'ALLOWED';
    exception when others then
      perform set_config('role', 'postgres', true);
      outcome := 'BLOCKED';
    end;
    res := res || format('technician sets own limited_access|BLOCKED|%s', outcome);

    -- 3. A technician editing a non-privileged field still works.
    perform set_config('role', 'authenticated', true);
    begin
      update profiles set full_name = full_name where id = tech;
      perform set_config('role', 'postgres', true);
      outcome := 'ALLOWED';
    exception when others then
      perform set_config('role', 'postgres', true);
      outcome := 'BLOCKED';
    end;
    res := res || format('technician edits own name|ALLOWED|%s', outcome);

    -- 4. An admin with their own JWT can set it (the service role is used for
    --    the fixture itself below).
    perform set_config('request.jwt.claims',
                       json_build_object('sub', adm::text, 'role', 'authenticated')::text, true);
    begin
      update profiles set limited_access = true where id = tech;
      outcome := 'ALLOWED';
    exception when others then
      outcome := 'BLOCKED';
    end;
    res := res || format('admin sets limited_access|ALLOWED|%s', outcome);

    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    update profiles set limited_access = true where id = tech;

    -- 5. The same technician, LIMITED.
    perform set_config('request.jwt.claims',
                       json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    res := res || format('limited: is_limited_account()|true|%s', is_limited_account());
    select count(*) into n from jobs;
    res := res || format('limited: jobs seen = jobs they are on|%s|%s', my_jobs, n);
    select count(*) into n from jobs j where not exists (
      select 1 from job_assignments ja where ja.job_id = j.id and ja.staff_id = tech);
    res := res || format('limited: jobs seen that they are NOT on|0|%s', n);
    select count(*) into n from customers;
    res := res || format('limited: customers seen = customers of their jobs|%s|%s', my_customers, n);
    select count(*) into n from sites;
    res := res || format('limited: sites seen = sites of their jobs|%s|%s', my_sites, n);
    select count(*) into n from backflow_devices;
    res := res || format('limited: backflow devices seen|0|%s', n);
    select count(*) into n from backflow_tests;
    res := res || format('limited: backflow tests seen|0|%s', n);
    select count(*) into n from job_notes;
    res := res || format('limited: job notes seen = notes on their jobs|%s|%s', my_notes, n);
    select count(*) into n from job_photos;
    res := res || format('limited: job photo rows seen = photos on their jobs|%s|%s', my_photo_rows, n);
    select count(*) into n from job_stage_notes s where not exists (
      select 1 from job_assignments ja where ja.job_id = s.job_id and ja.staff_id = tech);
    res := res || format('limited: stage notes seen on other jobs|0|%s', n);
    select count(*) into n from job_documents d where d.job_id is null or not exists (
      select 1 from job_assignments ja where ja.job_id = d.job_id and ja.staff_id = tech);
    res := res || format('limited: documents seen on other jobs|0|%s', n);
    select count(*) into n from purchase_orders_public;
    res := res || format('limited: purchase_orders_public rows = POs on their jobs|%s|%s', my_po, n);
    select count(*) into n from job_variations_public v where not exists (
      select 1 from job_assignments ja where ja.job_id = v.job_id and ja.staff_id = tech);
    res := res || format('limited: variations seen on other jobs|0|%s', n);
    select count(*) into n from storage.objects o
     where o.bucket_id in ('job-photos', 'job-documents', 'job-audio')
       and not exists (select 1 from job_assignments ja
                        where ja.job_id::text = split_part(o.name, '/', 1) and ja.staff_id = tech);
    res := res || format('limited: job files seen on other jobs|0|%s', n);

    begin
      update profiles set limited_access = false where id = tech;
      perform set_config('role', 'postgres', true);
      outcome := 'ALLOWED';
    exception when others then
      perform set_config('role', 'postgres', true);
      outcome := 'BLOCKED';
    end;
    res := res || format('limited technician clears own limited_access|BLOCKED|%s', outcome);

    -- 6. Flag off again: exactly what they saw before.
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    update profiles set limited_access = false where id = tech;
    perform set_config('request.jwt.claims',
                       json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into n from jobs;
    res := res || format('unlimited again: jobs as before|%s|%s', before_jobs, n);
    select count(*) into n from customers;
    res := res || format('unlimited again: customers as before|%s|%s', before_customers, n);
    select count(*) into n from sites;
    res := res || format('unlimited again: sites as before|%s|%s', before_sites, n);
    select count(*) into n from backflow_devices;
    res := res || format('unlimited again: backflow devices as before|%s|%s', before_devices, n);
    select count(*) into n from backflow_tests;
    res := res || format('unlimited again: backflow tests as before|%s|%s', before_tests, n);
    select count(*) into n from job_notes;
    res := res || format('unlimited again: job notes as before|%s|%s', before_notes, n);
    perform set_config('role', 'postgres', true);

    -- 7. Office/admin untouched.
    perform set_config('request.jwt.claims',
                       json_build_object('sub', off::text, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into n from jobs;
    res := res || format('office/admin sees every job|%s|%s', all_jobs, n);
    select count(*) into n from backflow_devices;
    res := res || format('office/admin sees every backflow device|%s|%s', all_devices, n);
    perform set_config('role', 'postgres', true);

    -- 8. Static checks.
    res := res || format('anon can execute is_limited_account|false|%s',
      has_function_privilege('anon', 'public.is_limited_account()', 'execute'));
    select count(*) into n from pg_policy
     where polname like 'limited accounts:%' and not polpermissive and polcmd = 'r';
    res := res || format('restrictive limited-account SELECT policies|10|%s', n);

    raise exception using errcode = 'ZX001', message = 'undo test changes';
  exception when sqlstate 'ZX001' then
    null;
  end;

  if coalesce(array_length(res, 1), 0) = 0 then
    raise exception 'test recorded no scenarios';
  end if;
  foreach line in array res loop
    parts := string_to_array(line, '|');
    parts[3] := case parts[3] when 't' then 'true' when 'f' then 'false' else parts[3] end;
    if parts[2] is distinct from parts[3] then
      n_fail := n_fail + 1;
      failures := failures || format(E'\n  - %s: expected %s, got %s', parts[1], parts[2], parts[3]);
    end if;
  end loop;
  if n_fail > 0 then
    raise exception E'0110 FAILED — % of % scenario(s):%', n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;

select '0110 PASSED' as result;
