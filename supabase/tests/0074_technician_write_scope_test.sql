-- ============================================================================
-- REGRESSION TEST for 0074 — technician write scope.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0074_technician_write_scope_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Fixtures and
-- scenarios run inside an inner block that ends by raising a private SQLSTATE,
-- rolling every change back; only the results (a local variable) survive to be
-- reported. Success prints nothing; a failure names each failing scenario.
--
-- WHY ROW COUNTS, NOT JUST ERRORS. A restrictive USING clause does not raise —
-- it filters the row out and the UPDATE/DELETE "succeeds" against zero rows.
-- A scenario is therefore BLOCKED on an error OR on zero rows affected, and
-- ALLOWED only when a row really changed.
--
-- Both halves are tested: what a technician must no longer do, and what they
-- legitimately still do (sign off their job, add notes, record a backflow test,
-- fix their own unbilled clock time). A fix that blocked everything would pass
-- the first half and break the field app.
--
-- SIDE EFFECT: the fixture inserts two jobs. jobs.job_number is a serial, and
-- a sequence does not roll back, so the next real job skips two numbers.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech   uuid;
  off    uuid;
  cust   uuid := gen_random_uuid();
  mine   uuid := gen_random_uuid();   -- job assigned to the technician
  theirs uuid := gen_random_uuid();   -- job NOT assigned to the technician
  dev    uuid := gen_random_uuid();
  bft    uuid := gen_random_uuid();
  te_open   uuid := gen_random_uuid();
  te_billed uuid := gen_random_uuid();
  other_note uuid := gen_random_uuid();
  sc record;
  n int;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into tech from profiles where role = 'technician' and coalesce(is_active, true) limit 1;
    -- Prefer an office user; fall back to an admin when the database has none
    -- (production has no office-role staff). Admins pass the same
    -- is_office_or_admin() checks, so every assertion means the same thing.
    select id into off  from profiles where role in ('office', 'admin') and coalesce(is_active, true)
      order by (role = 'office') desc limit 1;
    if tech is null or off is null then
      raise exception 'fixture missing: need an active technician and an office user or admin';
    end if;

    -- Fixtures, written as postgres with no JWT (RLS and the triggers' early
    -- return both let this through).
    perform set_config('request.jwt.claims', '', true);
    insert into customers (id, name) values (cust, '0074 Customer');
    insert into jobs (id, customer_id, assigned_to, title) values (mine, cust, tech, '0074 mine');
    insert into jobs (id, customer_id, title) values (theirs, cust, '0074 theirs');
    insert into job_notes (id, job_id, author_id, content) values (other_note, mine, off, 'office note');
    insert into backflow_devices (id, customer_id, water_authority, device_type)
      values (dev, cust, 'yarra_valley_water', 'rpzd');
    insert into backflow_tests (id, device_id, test_type, result, tester_name)
      values (bft, dev, 'annual', 'pass', 'CI');
    insert into time_entries (id, job_id, staff_id, clock_in, clock_out, hours, entry_type)
      values (te_open,   mine, tech, now() - interval '3 hours', now() - interval '2 hours', 1, 'work'),
             (te_billed, mine, tech, now() - interval '5 hours', now() - interval '4 hours', 1, 'work');
    insert into job_items (job_id, name, quantity, unit_price, time_entry_id)
      values (mine, 'Labour', 1, 100, te_billed);

    -- ---- As the technician -------------------------------------------------
    perform set_config('request.jwt.claims',
                       json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    for sc in
      select * from (values
        (1,  'tech edits a customer', 'BLOCKED',
             format('update customers set email = %L where id = %L', 'x@evil.test', cust)),
        (2,  'tech deletes a customer', 'BLOCKED',
             format('delete from customers where id = %L', cust)),
        (3,  'tech creates a job', 'BLOCKED',
             format('insert into jobs (customer_id, title) values (%L, %L)', cust, 'x')),
        (4,  'tech edits a job not assigned to them', 'BLOCKED',
             format('update jobs set notes = %L where id = %L', 'x', theirs)),
        (5,  'tech edits their own job', 'ALLOWED',
             format('update jobs set notes = %L where id = %L', 'ok', mine)),
        (6,  'tech signs off their job (ready_to_invoice=true)', 'ALLOWED',
             format('update jobs set ready_to_invoice = true where id = %L', mine)),
        (7,  'tech clears ready_to_invoice', 'BLOCKED',
             format('update jobs set ready_to_invoice = false where id = %L', mine)),
        (8,  'tech sets admin_status on own job', 'BLOCKED',
             format('update jobs set admin_status = %L where id = %L', 'approved', mine)),
        (9,  'tech adds a note on their job', 'ALLOWED',
             format('insert into job_notes (job_id, author_id, content) values (%L, %L, %L)', mine, tech, 'n')),
        (10, 'tech adds a note on another job', 'BLOCKED',
             format('insert into job_notes (job_id, author_id, content) values (%L, %L, %L)', theirs, tech, 'n')),
        (11, 'tech edits the office''s note', 'BLOCKED',
             format('update job_notes set content = %L where id = %L', 'x', other_note)),
        (12, 'tech records a backflow test', 'ALLOWED',
             format('insert into backflow_tests (device_id, test_type, result, tester_name) values (%L, %L, %L, %L)',
                    dev, 'annual', 'pass', 'Tech')),
        (13, 'tech edits a backflow test', 'ALLOWED',
             format('update backflow_tests set remarks = %L where id = %L', 'ok', bft)),
        (14, 'tech deletes a backflow test', 'BLOCKED',
             format('delete from backflow_tests where id = %L', bft)),
        (15, 'tech deactivates a backflow device', 'BLOCKED',
             format('update backflow_devices set is_active = false where id = %L', dev)),
        (16, 'tech deletes a backflow device', 'BLOCKED',
             format('delete from backflow_devices where id = %L', dev)),
        (17, 'tech fixes their own unbilled entry', 'ALLOWED',
             format('update time_entries set hours = 1.5 where id = %L', te_open)),
        (18, 'tech edits their billed entry', 'BLOCKED',
             format('update time_entries set hours = 9 where id = %L', te_billed)),
        (19, 'tech deletes their billed entry', 'BLOCKED',
             format('delete from time_entries where id = %L', te_billed)),
        (20, 'tech reads the audit log', 'BLOCKED',
             'select * from time_entry_changes')
      ) v(ord, scenario, expected, stmt)
      order by ord
    loop
      begin
        perform set_config('role', 'authenticated', true);
        execute sc.stmt;
        get diagnostics n = row_count;
        perform set_config('role', 'postgres', true);
        outcome := case when n > 0 then 'ALLOWED' else 'BLOCKED' end;
      exception when others then
        perform set_config('role', 'postgres', true);
        outcome := 'BLOCKED';
      end;
      res := res || format('%s|%s|%s', sc.scenario, sc.expected, outcome);
    end loop;

    res := res || format('tech edit is stamped edited_by in the database|true|%s',
      (select (edited_by = tech) from time_entries where id = te_open));
    res := res || format('tech edit is in the audit log|true|%s',
      (select count(*) = 1 from time_entry_changes where time_entry_id = te_open and changed_by = tech));
    res := res || format('audit row hides rate_override|false|%s',
      (select coalesce(bool_or(old_row ? 'rate_override'), false) from time_entry_changes where time_entry_id = te_open));

    -- ---- Office (or admin) keeps every power --------------------------------
    perform set_config('request.jwt.claims',
                       json_build_object('sub', off::text, 'role', 'authenticated')::text, true);
    for sc in
      select * from (values
        (1, 'office edits a customer', 'ALLOWED',
            format('update customers set email = %L where id = %L', 'ok@test', cust)),
        (2, 'office edits an unassigned job', 'ALLOWED',
            format('update jobs set admin_status = %L where id = %L', 'approved', theirs)),
        (3, 'office edits a billed entry', 'ALLOWED',
            format('update time_entries set hours = 2 where id = %L', te_billed)),
        (4, 'office deletes a backflow test', 'ALLOWED',
            format('delete from backflow_tests where id = %L', bft))
      ) v(ord, scenario, expected, stmt)
      order by ord
    loop
      begin
        perform set_config('role', 'authenticated', true);
        execute sc.stmt;
        get diagnostics n = row_count;
        perform set_config('role', 'postgres', true);
        outcome := case when n > 0 then 'ALLOWED' else 'BLOCKED' end;
      exception when others then
        perform set_config('role', 'postgres', true);
        outcome := 'BLOCKED';
      end;
      res := res || format('%s|%s|%s', sc.scenario, sc.expected, outcome);
    end loop;

    -- Undo every change above. Only `res` (a variable) survives.
    raise exception using errcode = 'ZX001', message = 'undo test changes';
  exception when sqlstate 'ZX001' then
    null;
  end;

  if coalesce(array_length(res, 1), 0) = 0 then
    raise exception 'test recorded no scenarios';
  end if;
  foreach line in array res loop
    parts := string_to_array(line, '|');
    -- format('%s', <boolean>) writes t / f; compare as true / false.
    parts[3] := case parts[3] when 't' then 'true' when 'f' then 'false' else parts[3] end;
    if parts[2] is distinct from parts[3] then
      n_fail := n_fail + 1;
      failures := failures || format(E'\n  - %s: expected %s, got %s', parts[1], parts[2], parts[3]);
    end if;
  end loop;
  if n_fail > 0 then
    raise exception E'% of % scenario(s) FAILED — 0074 technician write scope not in force:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
