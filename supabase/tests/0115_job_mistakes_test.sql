-- ============================================================================
-- GATE TEST for 0115 — mistake costs: office/admin only, technicians nothing,
-- the cost centre must be the job's own PO line, the amount must be > 0.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0115_job_mistakes_test.sql
--   or paste the whole file into the Supabase SQL editor AFTER 0115.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Writes run as a real
-- technician, then a real office/admin user, under the `authenticated` role, as
-- the app does. Builds its own fixtures. Trust only the final "0115 PASSED"
-- row: any failure raises, the editor shows a red error, and nothing is kept.
--
-- Needs an active technician and an active office/admin profile.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  office uuid;
  cust uuid := gen_random_uuid();
  job_a uuid := gen_random_uuid();
  job_b uuid := gen_random_uuid();
  po_a uuid := gen_random_uuid();
  po_b uuid := gen_random_uuid();
  line_a uuid := gen_random_uuid();
  line_b uuid := gen_random_uuid();
  seeded uuid := gen_random_uuid();
  m1 uuid := gen_random_uuid();
  n int;
  v text;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into tech from profiles where role = 'technician' and coalesce(is_active, true) limit 1;
    select id into office from profiles where role in ('office', 'admin') and coalesce(is_active, true) limit 1;
    if tech is null or office is null then
      raise exception 'fixture missing: need an active technician and an active office/admin user';
    end if;

    -- Fixtures as the session owner. The technician is ON job A, so being on
    -- the job is proven not to be enough.
    perform set_config('request.jwt.claims', '', true);
    insert into customers (id, name) values (cust, '0115 Customer');
    insert into jobs (id, customer_id, assigned_to, title) values (job_a, cust, tech, '0115 job A');
    insert into jobs (id, customer_id, title) values (job_b, cust, '0115 job B');
    insert into purchase_orders (id, job_id, po_number, total_value) values (po_a, job_a, '0115-A', 10000);
    insert into purchase_orders (id, job_id, po_number, total_value) values (po_b, job_b, '0115-B', 5000);
    insert into po_cost_centers (id, po_id, name, allocated_amount) values (line_a, po_a, 'Drainage', 10000);
    insert into po_cost_centers (id, po_id, name, allocated_amount) values (line_b, po_b, 'Drainage', 5000);
    insert into job_mistakes (id, job_id, cost_center_id, amount_ex_gst, description)
      values (seeded, job_a, line_a, 250, '0115 seeded mistake');

    -- ---------------------------------------------------------------- technician
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);

    select count(*) into n from job_mistakes where job_id = job_a;
    res := res || format('technician sees mistakes on their own job|0|%s', n);

    begin
      insert into job_mistakes (job_id, cost_center_id, amount_ex_gst, description)
        values (job_a, line_a, 100, '0115 tech insert');
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician logs a mistake|BLOCKED|%s', outcome);

    update job_mistakes set amount_ex_gst = 1 where id = seeded;
    get diagnostics n = row_count;
    res := res || format('technician updates a mistake (rows)|0|%s', n);

    delete from job_mistakes where id = seeded;
    get diagnostics n = row_count;
    res := res || format('technician deletes a mistake (rows)|0|%s', n);

    -- ---------------------------------------------------------------- office
    perform set_config('request.jwt.claims', json_build_object('sub', office::text, 'role', 'authenticated')::text, true);

    begin
      insert into job_mistakes (id, job_id, cost_center_id, amount_ex_gst, description, cause, staff_id, entered_by)
        values (m1, job_a, line_a, 480.50, 'Pipe laid at the wrong fall, dug up and relaid', 'Wrong level', tech, tech);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('office logs a mistake|ALLOWED|%s', outcome);

    select (entered_by = office)::text into v from job_mistakes where id = m1;
    res := res || format('entered_by is the caller, not what was sent|true|%s', coalesce(v, 'null'));
    select (occurred_on = (now() at time zone 'Australia/Melbourne')::date)::text into v from job_mistakes where id = m1;
    res := res || format('occurred_on defaults to Melbourne today|true|%s', coalesce(v, 'null'));

    select count(*) into n from job_mistakes where job_id = job_a;
    res := res || format('office reads the job''s mistakes|2|%s', n);

    begin
      update job_mistakes set amount_ex_gst = 520, description = 'Relaid twice' where id = m1;
      get diagnostics n = row_count;
      outcome := case when n = 1 then 'ALLOWED' else 'NO ROWS' end;
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('office edits a mistake|ALLOWED|%s', outcome);

    begin
      update job_mistakes set cost_center_id = null where id = m1;
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('office untags a mistake (Not tagged)|ALLOWED|%s', outcome);

    begin
      insert into job_mistakes (job_id, cost_center_id, amount_ex_gst, description)
        values (job_a, line_b, 100, '0115 cross-job line');
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('cost centre from another job''s PO|BLOCKED|%s', outcome);

    begin
      update job_mistakes set cost_center_id = line_b where id = m1;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('moved onto another job''s cost centre|BLOCKED|%s', outcome);

    begin
      insert into job_mistakes (job_id, amount_ex_gst, description) values (job_a, 0, '0115 zero');
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('amount of 0|BLOCKED|%s', outcome);

    begin
      insert into job_mistakes (job_id, amount_ex_gst, description) values (job_a, -50, '0115 negative');
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('negative amount|BLOCKED|%s', outcome);

    begin
      insert into job_mistakes (job_id, amount_ex_gst, description) values (job_a, 10, '   ');
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('blank description|BLOCKED|%s', outcome);

    delete from job_mistakes where id = m1;
    get diagnostics n = row_count;
    res := res || format('office deletes a mistake (rows)|1|%s', n);

    -- Removing the PO line leaves the mistake on the job, untagged.
    perform set_config('request.jwt.claims', '', true);
    perform set_config('role', 'postgres', true);
    delete from po_cost_centers where id = line_a;
    select coalesce(cost_center_id::text, 'null') into v from job_mistakes where id = seeded;
    res := res || format('deleting the PO line untags the mistake|null|%s', coalesce(v, 'missing'));

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
    raise exception E'0115 gate FAILED — % of % scenario(s):%', n_fail, array_length(res, 1), failures;
  end if;
end;
$$;

select '0115 PASSED' as result;
