-- ============================================================================
-- GATE TEST for 0118 — a technician starts work on a job themselves; the
-- booking follows their clock.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0118_self_start_bookings_test.sql
--   or paste the whole file into the Supabase SQL editor AFTER 0118.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Calls run as a real
-- technician, then a real office/admin user, under the `authenticated` role,
-- as the app does. Builds its own fixtures. Trust only the final
-- "0118 PASSED" row: any failure raises, the editor shows a red error, and
-- nothing is kept.
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
  job_x uuid := gen_random_uuid();   -- another open job (its PO line is the wrong one for job A)
  job_c uuid := gen_random_uuid();   -- completed
  po_a uuid := gen_random_uuid();
  po_x uuid := gen_random_uuid();
  po_c uuid := gen_random_uuid();
  line_open uuid := gen_random_uuid();
  line_done uuid := gen_random_uuid();
  line_x uuid := gen_random_uuid();
  line_c uuid := gen_random_uuid();
  b1 uuid := gen_random_uuid();
  b2 uuid := gen_random_uuid();
  e1 uuid := gen_random_uuid();
  e2 uuid := gen_random_uuid();
  t_in timestamptz := date_trunc('second', now()) - interval '2 hours';
  t_out timestamptz := date_trunc('second', now()) - interval '10 minutes';
  bk job_bookings;
  n int;
  v text;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into tech from profiles
     where role = 'technician' and coalesce(is_active, true) and not coalesce(limited_access, false) limit 1;
    select id into office from profiles where role in ('office', 'admin') and coalesce(is_active, true) limit 1;
    if tech is null or office is null then
      raise exception 'fixture missing: need an active technician and an active office/admin user';
    end if;

    -- Fixtures as the session owner. The technician is on NONE of these jobs.
    perform set_config('request.jwt.claims', '', true);
    insert into customers (id, name) values (cust, '0118 Customer');
    insert into jobs (id, customer_id, title, status) values (job_a, cust, '0118 job A', 'pending');
    insert into jobs (id, customer_id, title, status) values (job_x, cust, '0118 job X', 'pending');
    insert into jobs (id, customer_id, title, status) values (job_c, cust, '0118 job C', 'completed');
    insert into purchase_orders (id, job_id, po_number, total_value) values (po_a, job_a, '0118-A', 1000);
    insert into purchase_orders (id, job_id, po_number, total_value) values (po_x, job_x, '0118-X', 1000);
    insert into purchase_orders (id, job_id, po_number, total_value) values (po_c, job_c, '0118-C', 1000);
    insert into po_cost_centers (id, po_id, name, allocated_amount) values (line_open, po_a, 'Drainage', 500);
    insert into po_cost_centers (id, po_id, name, allocated_amount, completed_at) values (line_done, po_a, 'Rough in', 500, now());
    insert into po_cost_centers (id, po_id, name, allocated_amount) values (line_x, po_x, 'Drainage', 500);
    insert into po_cost_centers (id, po_id, name, allocated_amount) values (line_c, po_c, 'Drainage', 500);

    res := res || format('anon may run self_start_job_booking|false|%s',
      has_function_privilege('anon', 'public.self_start_job_booking(uuid, uuid, uuid, uuid)', 'execute'));

    -- ---------------------------------------------------------------- technician
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);

    begin
      insert into job_bookings (job_id, staff_id, cost_center_id, starts_at) values (job_a, tech, line_open, now());
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician writes job_bookings directly|BLOCKED|%s', outcome);

    begin
      perform self_start_job_booking(b1, job_a, line_done, e1);
      outcome := 'ALLOWED';
    exception when others then outcome := sqlstate;
    end;
    res := res || format('completed stage refused|MJ115|%s', outcome);

    begin
      perform self_start_job_booking(b1, job_a, line_x, e1);
      outcome := 'ALLOWED';
    exception when others then outcome := sqlstate;
    end;
    res := res || format('another job''s cost centre refused|MJ114|%s', outcome);

    begin
      perform self_start_job_booking(b1, job_a, null, e1);
      outcome := 'ALLOWED';
    exception when others then outcome := sqlstate;
    end;
    res := res || format('no cost centre refused|MJ114|%s', outcome);

    begin
      perform self_start_job_booking(b1, job_c, line_c, e1);
      outcome := 'ALLOWED';
    exception when others then outcome := sqlstate;
    end;
    res := res || format('completed job refused (0096 sentence)|MJ001|%s', outcome);

    select count(*) into n from job_assignments where job_id = job_a and staff_id = tech;
    res := res || format('refusals left the technician off the crew|0|%s', n);

    begin
      bk := self_start_job_booking(b1, job_a, line_open, e1);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician starts work on an open stage|ALLOWED|%s', outcome);
    res := res || format('booking is the caller''s own|true|%s', (bk.staff_id = tech and bk.created_by = tech));
    res := res || format('booking has no end yet|true|%s', (bk.ends_at is null));
    res := res || format('booking is on the chosen stage|true|%s', (bk.cost_center_id = line_open));
    res := res || format('booking is linked to the clock-on|true|%s', (bk.clock_entry_id = e1));
    res := res || format('booking starts now (to the minute)|true|%s', (bk.starts_at between now() - interval '2 minutes' and now()));

    select count(*) into n from job_assignments where job_id = job_a and staff_id = tech;
    res := res || format('technician is on the crew (0079)|1|%s', n);
    res := res || format('the job is now theirs to manage|true|%s', user_can_manage_job(job_a::text));

    begin
      bk := self_start_job_booking(b1, job_a, line_open, e1);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlstate;
    end;
    res := res || format('a retry returns the same booking|ALLOWED|%s', outcome);
    select count(*) into n from job_bookings where job_id = job_a;
    res := res || format('the retry added nothing|1|%s', n);

    begin
      perform self_start_job_booking(b1, job_x, line_x, e1);
      outcome := 'ALLOWED';
    exception when others then outcome := sqlstate;
    end;
    res := res || format('the same booking id on another job|MJ112|%s', outcome);

    -- The clock-on reaches the server (the phone's queued insert).
    begin
      insert into time_entries (id, job_id, staff_id, clock_in, entry_type, cost_center_id)
        values (e1, job_a, tech, t_in, 'work', line_open);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician clocks on (crew now)|ALLOWED|%s', outcome);
    select * into bk from job_bookings where id = b1;
    res := res || format('booking starts at the clock-on|true|%s', (bk.starts_at is not distinct from t_in));
    res := res || format('booking still open while clocked on|true|%s', (bk.ends_at is null));

    update time_entries set clock_out = t_out, hours = round(extract(epoch from (t_out - t_in)) / 3600, 2) where id = e1;
    select * into bk from job_bookings where id = b1;
    res := res || format('clock-off ends the booking|true|%s', (bk.ends_at is not distinct from t_out));

    -- Signed off (job closed) BEFORE the clock-off reaches the server.
    bk := self_start_job_booking(b2, job_a, line_open, e2);
    insert into time_entries (id, job_id, staff_id, clock_in, entry_type, cost_center_id)
      values (e2, job_a, tech, t_out + interval '1 minute', 'work', line_open);
    perform set_config('request.jwt.claims', '', true);
    perform set_config('role', 'postgres', true);
    update jobs set status = 'completed' where id = job_a;
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    begin
      update time_entries set clock_out = now(), hours = 0.1 where id = e2;
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('clock-off after the job was closed still saves|ALLOWED|%s', outcome);
    select (ends_at is not null)::text into v from job_bookings where id = b2;
    res := res || format('…and ends its booking|true|%s', coalesce(v, 'missing'));

    select completed_at is not null into v from po_cost_centers_public where id = line_done;
    res := res || format('technician sees a stage''s completion (view)|true|%s', coalesce(v, 'missing'));

    -- ---------------------------------------------------------------- office
    perform set_config('request.jwt.claims', json_build_object('sub', office::text, 'role', 'authenticated')::text, true);
    begin
      perform self_start_job_booking(gen_random_uuid(), job_x, line_x, gen_random_uuid());
      outcome := 'ALLOWED';
    exception when others then outcome := sqlstate;
    end;
    res := res || format('office can''t self-start (technicians only)|MJ111|%s', outcome);

    -- ---------------------------------------------------------------- limited technician
    perform set_config('request.jwt.claims', '', true);
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    update profiles set limited_access = true where id = tech;
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    begin
      perform self_start_job_booking(gen_random_uuid(), job_x, line_x, gen_random_uuid());
      outcome := 'ALLOWED';
    exception when others then outcome := sqlstate;
    end;
    res := res || format('limited-access account refused|MJ111|%s', outcome);

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
    raise exception E'0118 gate FAILED — % of % scenario(s):%', n_fail, array_length(res, 1), failures;
  end if;
end;
$$;

select '0118 PASSED' as result;
