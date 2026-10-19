-- ============================================================================
-- REGRESSION TEST for 0079 — job bookings, the derived job schedule and crew,
-- and the translation of old-style writes (mobile builds ≤15, today's board).
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0079_job_bookings_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
--
-- SIDE EFFECT: the fixture inserts two jobs; jobs.job_number is a serial, so
-- the next real job skips two numbers.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  t1 uuid;
  t2 uuid;
  off uuid;
  cust uuid := gen_random_uuid();
  j uuid := gen_random_uuid();
  j2 uuid := gen_random_uuid();
  cc1 uuid;
  cc2 uuid;
  po uuid := gen_random_uuid();
  mon timestamptz := '2026-11-02 07:00+11';
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
  r record;
begin
  begin
    select id into t1 from profiles where role = 'technician' and coalesce(is_active, true) order by id limit 1;
    select id into t2 from profiles where role = 'technician' and coalesce(is_active, true) and id <> t1 order by id limit 1;
    select id into off from profiles where role in ('office', 'admin') and coalesce(is_active, true)
      order by (role = 'office') desc limit 1;
    if t1 is null or off is null then
      raise exception 'fixture missing: need an active technician and an office user or admin';
    end if;
    -- Production may have only one technician; a second person is still a
    -- different crew member for these purposes.
    t2 := coalesce(t2, off);

    perform set_config('request.jwt.claims', '', true);
    insert into customers (id, name) values (cust, '0079 Customer');
    insert into jobs (id, customer_id, title) values (j, cust, '0079 bookings'), (j2, cust, '0079 legacy');
    insert into purchase_orders (id, job_id, po_number) values (po, j, '0079-PO');
    insert into po_cost_centers (po_id, name) values (po, 'Rough-in') returning id into cc1;
    insert into po_cost_centers (po_id, name) values (po, 'Fit-off') returning id into cc2;

    -- Office books as themselves.
    perform set_config('request.jwt.claims', json_build_object('sub', off::text, 'role', 'authenticated')::text, true);

    -- 1. One booking: the job mirrors it exactly, and the tech joins the crew.
    insert into job_bookings (job_id, staff_id, cost_center_id, starts_at, ends_at, daily, all_day)
    values (j, t1, cc1, mon, mon + interval '1 day 8 hours 30 minutes', true, false);
    select * into r from jobs where id = j;
    res := res || format('single booking: job start mirrors it|%s|%s', mon, r.scheduled_start);
    res := res || format('single booking: job is daily like it|true|%s', r.schedule_daily);
    res := res || format('single booking: job cost centre mirrors it|%s|%s', cc1, r.scheduled_cost_center_id);
    res := res || format('single booking: tech is on the crew|true|%s',
      exists (select 1 from job_assignments where job_id = j and staff_id = t1));

    -- 2. A second tech, different time and cost centre.
    insert into job_bookings (job_id, staff_id, cost_center_id, starts_at, ends_at)
    values (j, t2, cc2, mon + interval '3 days 1 hour', mon + interval '3 days 5 hours');
    select * into r from jobs where id = j;
    res := res || format('two bookings: job starts at the earliest|%s|%s', mon, r.scheduled_start);
    res := res || format('two bookings: job ends at the latest|%s|%s', mon + interval '3 days 5 hours', r.scheduled_end);
    res := res || format('two bookings: job not daily (windows differ)|false|%s', r.schedule_daily);
    res := res || format('two bookings: job cost centre cleared (they differ)|true|%s', r.scheduled_cost_center_id is null);
    res := res || format('two bookings: both techs on the crew|2|%s',
      (select count(*) from job_assignments where job_id = j and staff_id in (t1, t2)));

    -- 3. The same tech can be booked twice on one job.
    insert into job_bookings (job_id, staff_id, cost_center_id, starts_at, ends_at)
    values (j, t1, cc2, mon + interval '4 days', mon + interval '4 days 4 hours');
    res := res || format('same tech booked twice|2|%s', (select count(*) from job_bookings where job_id = j and staff_id = t1));
    res := res || format('still one crew row for them|1|%s', (select count(*) from job_assignments where job_id = j and staff_id = t1));

    -- 4. Removing t2's only booking takes them off the crew; t1 stays.
    delete from job_bookings where job_id = j and staff_id = t2;
    res := res || format('last booking removed: tech leaves the crew|false|%s',
      exists (select 1 from job_assignments where job_id = j and staff_id = t2));
    res := res || format('other tech stays on the crew|true|%s',
      exists (select 1 from job_assignments where job_id = j and staff_id = t1));

    -- 5. A technician cannot write bookings.
    perform set_config('request.jwt.claims', json_build_object('sub', t1::text, 'role', 'authenticated')::text, true);
    begin
      perform set_config('role', 'authenticated', true);
      insert into job_bookings (job_id, staff_id, starts_at) values (j, t1, mon);
      perform set_config('role', 'postgres', true);
      outcome := 'ALLOWED';
    exception when others then
      perform set_config('role', 'postgres', true);
      outcome := 'BLOCKED';
    end;
    res := res || format('technician cannot create a booking|BLOCKED|%s', outcome);
    perform set_config('request.jwt.claims', json_build_object('sub', off::text, 'role', 'authenticated')::text, true);

    -- 6. OLD-STYLE: crew then a job-level schedule write (mobile ≤15 / board).
    perform set_job_assignments(j2, array[t1, t2]);
    update jobs set scheduled_start = mon, scheduled_end = mon + interval '4 hours' where id = j2;
    res := res || format('legacy schedule write: one booking per crew member|2|%s',
      (select count(*) from job_bookings where job_id = j2));
    res := res || format('legacy schedule write: bookings carry the window|2|%s',
      (select count(*) from job_bookings where job_id = j2 and starts_at = mon and ends_at = mon + interval '4 hours'));

    -- 7. OLD-STYLE reschedule moves everyone (rebuilds on the new window).
    update jobs set scheduled_start = mon + interval '1 day', scheduled_end = mon + interval '1 day 4 hours' where id = j2;
    res := res || format('legacy reschedule moves every booking|2|%s',
      (select count(*) from job_bookings where job_id = j2 and starts_at = mon + interval '1 day'));

    -- 8. OLD-STYLE crew removal drops that person's booking.
    perform set_job_assignments(j2, array[t1]);
    res := res || format('legacy crew removal drops their booking|0|%s',
      (select count(*) from job_bookings where job_id = j2 and staff_id = t2));

    -- 9. OLD-STYLE crew add on a shared-window job gives them that window.
    perform set_job_assignments(j2, array[t1, t2]);
    res := res || format('legacy crew add: newcomer gets the shared window|1|%s',
      (select count(*) from job_bookings where job_id = j2 and staff_id = t2 and starts_at = mon + interval '1 day'));

    -- 10. Clearing every booking unschedules the job.
    delete from job_bookings where job_id = j;
    res := res || format('no bookings: job is unscheduled|true|%s',
      (select scheduled_start is null from jobs where id = j));

    -- 11. anon cannot read bookings.
    res := res || format('anon cannot read job_bookings|false|%s',
      has_table_privilege('anon', 'public.job_bookings', 'select'));

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
    raise exception E'% of % scenario(s) FAILED — job bookings:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
