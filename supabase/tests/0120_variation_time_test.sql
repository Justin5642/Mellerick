-- ============================================================================
-- GATE TEST for 0120 — time against variations: the crew tag their OWN time to
-- a variation on the same job (never another job's, never a rejected one,
-- never travel), and can untag it; the office tags anyone's; only the office
-- sets "charged by the hour"; cost links are office/admin only, same job, one
-- variation per cost; a rejected variation gives its time and links back;
-- deletes clean up.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0120_variation_time_test.sql
--   or paste the whole file into the Supabase SQL editor AFTER 0120.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Writes run as a
-- real technician and an office/admin user under the `authenticated` role, as
-- the app does. Builds its own fixtures. Trust only the final "0120 PASSED"
-- row: any failure raises, the editor shows a red error, and nothing is kept.
--
-- Needs an active technician and an active office or admin user.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  office uuid;
  cust uuid := gen_random_uuid();
  job_a uuid := gen_random_uuid();
  job_b uuid := gen_random_uuid();
  v_open uuid := gen_random_uuid();
  v_two uuid := gen_random_uuid();
  v_three uuid := gen_random_uuid();
  v_rej uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_tech uuid := gen_random_uuid();
  te_own uuid := gen_random_uuid();
  te_other uuid := gen_random_uuid();
  te_new uuid := gen_random_uuid();
  te_travel uuid := gen_random_uuid();
  exp_a uuid := gen_random_uuid();
  exp_a2 uuid := gen_random_uuid();
  exp_b uuid := gen_random_uuid();
  exp_seed uuid := gen_random_uuid();
  n int;
  v text;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into tech from profiles where role = 'technician' and coalesce(is_active, true) and not coalesce(limited_access, false) limit 1;
    select id into office from profiles where role in ('office', 'admin') and coalesce(is_active, true) order by (role = 'office') desc limit 1;
    if tech is null or office is null then
      raise exception 'fixture missing: need an active technician and an active office or admin user';
    end if;

    -- Fixtures as the session owner. The technician is on job A, not job B.
    perform set_config('request.jwt.claims', '', true);
    insert into customers (id, name) values (cust, '0120 Customer');
    insert into jobs (id, customer_id, assigned_to, title) values (job_a, cust, tech, '0120 job A');
    insert into jobs (id, customer_id, title) values (job_b, cust, '0120 job B');
    insert into job_variations (id, job_id, custom_name, quantity, unit, logged_by) values
      (v_open, job_a, '0120 Hit rock', 1, 'unit', tech),
      (v_two, job_a, '0120 Extra pit', 1, 'unit', tech),
      (v_three, job_a, '0120 To delete', 1, 'unit', tech),
      (v_rej, job_a, '0120 Rejected', 1, 'unit', tech),
      (v_b, job_b, '0120 Other job', 1, 'unit', tech);
    update job_variations set status = 'rejected' where id = v_rej;
    insert into time_entries (id, job_id, staff_id, clock_in, clock_out, entry_type, hours) values
      (te_own, job_a, tech, now() - interval '5 hours', now() - interval '4 hours', 'work', 1),
      (te_other, job_a, office, now() - interval '5 hours', now() - interval '4 hours', 'work', 1),
      (te_travel, job_a, tech, now() - interval '7 hours', now() - interval '6 hours', 'travel', 1);
    insert into job_expenses (id, job_id, supplier_name, category, amount, gst_amount) values
      (exp_a, job_a, '0120 Supplier', 'materials', 300, 30),
      (exp_a2, job_a, '0120 Supplier', 'materials', 100, 10),
      (exp_b, job_b, '0120 Supplier', 'materials', 300, 30),
      (exp_seed, job_a, '0120 Supplier', 'materials', 50, 5);
    -- One link already there, so a technician who could read the table would see it.
    insert into variation_cost_links (variation_id, source, source_id) values (v_two, 'job_expense', exp_seed);

    -- ---------------------------------------------------------------- technician
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);

    begin
      select count(*) into n from time_entries where id = te_own and variation_id is null;
      outcome := case when n = 1 then 'ALLOWED' else 'NO ROW' end;
    exception when insufficient_privilege then outcome := 'BLOCKED';
    end;
    res := res || format('technician reads variation_id on their own entry|ALLOWED|%s', outcome);

    begin
      perform rate_override from time_entries where id = te_own;
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    end;
    res := res || format('technician still can''t read rate_override|BLOCKED|%s', outcome);

    begin
      insert into time_entries (id, job_id, staff_id, clock_in, clock_out, entry_type, hours, variation_id)
        values (te_new, job_a, tech, now() - interval '3 hours', now() - interval '2 hours', 'work', 1, v_open);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician clocks time onto a variation on their job|ALLOWED|%s', outcome);

    begin
      insert into time_entries (job_id, staff_id, clock_in, clock_out, entry_type, hours, variation_id)
        values (job_a, tech, now() - interval '9 hours', now() - interval '8 hours', 'work', 1, v_b);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician tags time to another job''s variation|BLOCKED|%s', outcome);

    begin
      update time_entries set variation_id = v_rej where id = te_own;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician moves time onto a rejected variation|BLOCKED|%s', outcome);

    begin
      update time_entries set variation_id = v_open where id = te_travel;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician tags a travel entry|BLOCKED|%s', outcome);

    begin
      update time_entries set variation_id = v_open where id = te_own;
      get diagnostics n = row_count;
      outcome := case when n = 1 then 'ALLOWED' else 'NO ROW' end;
    exception when others then outcome := 'BLOCKED: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician moves their own entry onto a variation|ALLOWED|%s', outcome);

    begin
      update time_entries set variation_id = null where id = te_new;
      get diagnostics n = row_count;
      outcome := case when n = 1 then 'ALLOWED' else 'NO ROW' end;
    exception when others then outcome := 'BLOCKED: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician moves their own entry off a variation|ALLOWED|%s', outcome);
    update time_entries set variation_id = v_open where id = te_new;

    update time_entries set variation_id = v_open where id = te_other;
    get diagnostics n = row_count;
    res := res || format('technician tags someone else''s entry (rows changed)|0|%s', n);

    insert into job_variations (id, job_id, custom_name, quantity, unit, logged_by, is_hourly)
      values (v_tech, job_a, '0120 Tech logged', 1, 'unit', tech, true);
    perform set_config('role', 'postgres', true);
    select coalesce(is_hourly::text, 'null') into v from job_variations where id = v_tech;
    res := res || format('a technician''s "charged by the hour" is ignored|null|%s', v);
    perform set_config('role', 'authenticated', true);

    select count(*) into n from variation_cost_links;
    res := res || format('technician reads cost links (rows)|0|%s', n);
    begin
      insert into variation_cost_links (variation_id, source, source_id) values (v_open, 'job_expense', exp_a);
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician links a cost to a variation|BLOCKED|%s', outcome);

    -- ---------------------------------------------------------------- office
    perform set_config('request.jwt.claims', json_build_object('sub', office::text, 'role', 'authenticated')::text, true);

    begin
      update time_entries set variation_id = v_open where id = te_other;
      get diagnostics n = row_count;
      outcome := case when n = 1 then 'ALLOWED' else 'NO ROW' end;
    exception when others then outcome := 'BLOCKED: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('office moves anyone''s entry onto a variation|ALLOWED|%s', outcome);

    update job_variations set is_hourly = true where id = v_open;
    select coalesce(is_hourly::text, 'null') into v from job_variations where id = v_open;
    res := res || format('office marks a variation charged by the hour|true|%s', v);

    begin
      insert into variation_cost_links (variation_id, source, source_id) values (v_open, 'job_expense', exp_a);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('office links an expense on the job|ALLOWED|%s', outcome);

    select coalesce(created_by::text, 'null') into v from variation_cost_links where source_id = exp_a;
    res := res || format('the link records who made it|%s|%s', office, v);

    begin
      insert into variation_cost_links (variation_id, source, source_id) values (v_open, 'job_expense', exp_b);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('office links another job''s expense|BLOCKED|%s', outcome);

    begin
      insert into variation_cost_links (variation_id, source, source_id) values (v_two, 'job_expense', exp_a);
      outcome := 'ALLOWED';
    exception when unique_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('one expense linked to two variations|BLOCKED|%s', outcome);

    begin
      insert into variation_cost_links (variation_id, source, source_id) values (v_rej, 'job_expense', exp_a2);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('office links a cost to a rejected variation|BLOCKED|%s', outcome);

    insert into variation_cost_links (variation_id, source, source_id) values (v_two, 'job_expense', exp_a2);
    delete from job_expenses where id = exp_a2;
    select count(*) into n from variation_cost_links where source_id = exp_a2;
    res := res || format('deleting the expense removes its link|0|%s', n);

    update time_entries set variation_id = v_three where id = te_new;
    delete from job_variations where id = v_three;
    select coalesce(variation_id::text, 'null') into v from time_entries where id = te_new;
    res := res || format('deleting a variation leaves its time on the stage|null|%s', v);

    update job_variations set status = 'rejected' where id = v_open;
    select count(*) into n from time_entries where variation_id = v_open;
    res := res || format('rejecting a variation gives its time back to the stage|0|%s', n);
    select count(*) into n from variation_cost_links where variation_id = v_open;
    res := res || format('rejecting a variation removes its cost links|0|%s', n);

    perform set_config('role', 'postgres', true);
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
    raise exception E'0120 gate FAILED — % of % scenario(s):%', n_fail, array_length(res, 1), failures;
  end if;
  raise notice '0120 gate: % scenarios passed', array_length(res, 1);
end;
$$;

select '0120 PASSED' as result;
