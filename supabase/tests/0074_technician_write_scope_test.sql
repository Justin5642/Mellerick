-- ============================================================================
-- REGRESSION TEST for 0074 — technician write scope.
--
-- Everything happens inside a transaction that is ROLLED BACK:
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0074_technician_write_scope_test.sql
--
-- WHY ROW COUNTS, NOT JUST ERRORS. A restrictive USING clause does not raise —
-- it filters the row out and the UPDATE/DELETE "succeeds" against zero rows.
-- attempt() therefore reports BLOCKED for an error OR for zero rows affected,
-- and ALLOWED only when a row really changed.
--
-- Both halves are tested: what a technician must no longer do, and what they
-- legitimately still do (sign off their job, add notes, record a backflow test,
-- fix their own unbilled clock time). A fix that blocked everything would pass
-- the first half and break the field app.
-- ============================================================================

begin;

create temp table result(scenario text, expected text, actual text) on commit drop;

create function pg_temp.attempt(stmt text) returns text
language plpgsql as $$
declare n int;
begin
  perform set_config('role', 'authenticated', true);
  execute stmt;
  get diagnostics n = row_count;
  perform set_config('role', 'postgres', true);
  return case when n > 0 then 'ALLOWED' else 'BLOCKED' end;
exception when others then
  perform set_config('role', 'postgres', true);
  return 'BLOCKED';
end;
$$;

create function pg_temp.as_user(uid uuid) returns void
language sql as $$
  select set_config('request.jwt.claims',
                    json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);
$$;

do $$
declare
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
begin
  select id into tech from profiles where role = 'technician' and coalesce(is_active, true) limit 1;
  select id into off  from profiles where role = 'office'     and coalesce(is_active, true) limit 1;
  if tech is null or off is null then
    raise exception 'fixture missing: need an active technician and office user';
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

  perform pg_temp.as_user(tech);

  -- customers
  insert into result values ('tech edits a customer', 'BLOCKED',
    pg_temp.attempt(format('update customers set email = %L where id = %L', 'x@evil.test', cust)));
  insert into result values ('tech deletes a customer', 'BLOCKED',
    pg_temp.attempt(format('delete from customers where id = %L', cust)));

  -- jobs
  insert into result values ('tech creates a job', 'BLOCKED',
    pg_temp.attempt(format('insert into jobs (customer_id, title) values (%L, %L)', cust, 'x')));
  insert into result values ('tech edits a job not assigned to them', 'BLOCKED',
    pg_temp.attempt(format('update jobs set notes = %L where id = %L', 'x', theirs)));
  insert into result values ('tech edits their own job', 'ALLOWED',
    pg_temp.attempt(format('update jobs set notes = %L where id = %L', 'ok', mine)));
  insert into result values ('tech signs off their job (ready_to_invoice=true)', 'ALLOWED',
    pg_temp.attempt(format('update jobs set ready_to_invoice = true where id = %L', mine)));
  insert into result values ('tech clears ready_to_invoice', 'BLOCKED',
    pg_temp.attempt(format('update jobs set ready_to_invoice = false where id = %L', mine)));
  insert into result values ('tech sets admin_status on own job', 'BLOCKED',
    pg_temp.attempt(format('update jobs set admin_status = %L where id = %L', 'approved', mine)));

  -- notes
  insert into result values ('tech adds a note on their job', 'ALLOWED',
    pg_temp.attempt(format('insert into job_notes (job_id, author_id, content) values (%L, %L, %L)', mine, tech, 'n')));
  insert into result values ('tech adds a note on another job', 'BLOCKED',
    pg_temp.attempt(format('insert into job_notes (job_id, author_id, content) values (%L, %L, %L)', theirs, tech, 'n')));
  insert into result values ('tech edits the office''s note', 'BLOCKED',
    pg_temp.attempt(format('update job_notes set content = %L where id = %L', 'x', other_note)));

  -- backflow
  insert into result values ('tech records a backflow test', 'ALLOWED',
    pg_temp.attempt(format('insert into backflow_tests (device_id, test_type, result, tester_name) values (%L, %L, %L, %L)',
                           dev, 'annual', 'pass', 'Tech')));
  insert into result values ('tech edits a backflow test', 'ALLOWED',
    pg_temp.attempt(format('update backflow_tests set remarks = %L where id = %L', 'ok', bft)));
  insert into result values ('tech deletes a backflow test', 'BLOCKED',
    pg_temp.attempt(format('delete from backflow_tests where id = %L', bft)));
  insert into result values ('tech deactivates a backflow device', 'BLOCKED',
    pg_temp.attempt(format('update backflow_devices set is_active = false where id = %L', dev)));
  insert into result values ('tech deletes a backflow device', 'BLOCKED',
    pg_temp.attempt(format('delete from backflow_devices where id = %L', dev)));

  -- time entries
  insert into result values ('tech fixes their own unbilled entry', 'ALLOWED',
    pg_temp.attempt(format('update time_entries set hours = 1.5 where id = %L', te_open)));
  insert into result values ('tech edits their billed entry', 'BLOCKED',
    pg_temp.attempt(format('update time_entries set hours = 9 where id = %L', te_billed)));
  insert into result values ('tech deletes their billed entry', 'BLOCKED',
    pg_temp.attempt(format('delete from time_entries where id = %L', te_billed)));
  insert into result values ('tech edit is stamped edited_by in the database',
    'true', (select (edited_by = tech)::text from time_entries where id = te_open));
  insert into result values ('tech edit is in the audit log',
    'true', (select (count(*) = 1)::text from time_entry_changes where time_entry_id = te_open and changed_by = tech));
  insert into result values ('audit row hides rate_override',
    'false', (select bool_or(old_row ? 'rate_override')::text from time_entry_changes where time_entry_id = te_open));
  insert into result values ('tech reads the audit log', 'BLOCKED',
    pg_temp.attempt('select * from time_entry_changes'));

  -- office keeps every power
  perform pg_temp.as_user(off);
  insert into result values ('office edits a customer', 'ALLOWED',
    pg_temp.attempt(format('update customers set email = %L where id = %L', 'ok@test', cust)));
  insert into result values ('office edits an unassigned job', 'ALLOWED',
    pg_temp.attempt(format('update jobs set admin_status = %L where id = %L', 'approved', theirs)));
  insert into result values ('office edits a billed entry', 'ALLOWED',
    pg_temp.attempt(format('update time_entries set hours = 2 where id = %L', te_billed)));
  insert into result values ('office deletes a backflow test', 'ALLOWED',
    pg_temp.attempt(format('delete from backflow_tests where id = %L', bft)));
end;
$$;

select scenario,
       expected,
       actual,
       case when expected = actual then 'PASS' else '*** FAIL ***' end as verdict
from result;

do $$
declare failures int;
begin
  select count(*) into failures from result where expected <> actual;
  if failures > 0 then
    raise exception '% scenario(s) FAILED — 0074 technician write scope not in force', failures;
  end if;
  raise notice 'all scenarios passed';
end;
$$;

rollback;
