-- ============================================================================
-- REGRESSION TEST for 0096 — completed/cancelled jobs cannot be scheduled,
-- and nothing else that touches a closed job's schedule breaks.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0096_refuse_scheduling_closed_jobs_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Writes run as a
-- real office/admin user under the `authenticated` role, as the apps do.
--
-- SIDE EFFECT: the fixture inserts three jobs; jobs.job_number is a serial,
-- so the next real job skips three numbers.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  off uuid;
  cust uuid := gen_random_uuid();
  j_open uuid := gen_random_uuid();
  j_done uuid := gen_random_uuid();
  j_cancel uuid := gen_random_uuid();
  b uuid;
  b2 uuid;
  mon timestamptz := date_trunc('day', now()) + interval '7 days 7 hours';
  outcome text;
  state text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into off from profiles where role in ('office', 'admin') and coalesce(is_active, true)
      order by (role = 'office') desc limit 1;
    if off is null then
      raise exception 'fixture missing: need an office user or admin';
    end if;

    perform set_config('request.jwt.claims', json_build_object('sub', off::text, 'role', 'authenticated')::text, true);
    insert into customers (id, name) values (cust, '0096 Customer');
    insert into jobs (id, customer_id, title) values (j_open, cust, '0096 open job');
    insert into jobs (id, customer_id, title) values (j_done, cust, '0096 to be completed');
    insert into jobs (id, customer_id, title) values (j_cancel, cust, '0096 to be cancelled');

    -- Book the second job twice (unassigned: no crew row, no push) while open.
    insert into job_bookings (job_id, staff_id, starts_at, ends_at)
    values (j_done, null, mon, mon + interval '4 hours') returning id into b;
    insert into job_bookings (job_id, staff_id, starts_at, ends_at)
    values (j_done, null, mon + interval '1 day', mon + interval '1 day 4 hours') returning id into b2;

    perform set_config('role', 'authenticated', true);

    -- 1. Completing a scheduled job still works (status-only write).
    begin
      update jobs set status = 'completed', actual_end = now(), ready_to_invoice = true where id = j_done;
      outcome := 'ALLOWED';
    exception when others then
      outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('completing a scheduled job|ALLOWED|%s', outcome);

    -- 2. A new booking on the completed job is refused, with MJ001.
    begin
      insert into job_bookings (job_id, staff_id, starts_at, ends_at)
      values (j_done, null, mon + interval '3 days', mon + interval '3 days 4 hours');
      outcome := 'ALLOWED';
    exception when sqlstate 'MJ001' then
      outcome := 'BLOCKED';
    when others then
      outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('new booking on a completed job|BLOCKED|%s', outcome);

    -- 3. Moving an existing booking of the completed job is refused.
    begin
      update job_bookings set starts_at = starts_at + interval '7 days', ends_at = ends_at + interval '7 days' where id = b;
      outcome := 'ALLOWED';
    exception when sqlstate 'MJ001' then
      outcome := 'BLOCKED';
    when others then
      outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('moving a booking of a completed job|BLOCKED|%s', outcome);

    -- 4. An old-style job window write on the completed job is refused.
    begin
      update jobs set scheduled_start = mon + interval '14 days', scheduled_end = mon + interval '14 days 4 hours' where id = j_done;
      outcome := 'ALLOWED';
    exception when sqlstate 'MJ001' then
      outcome := 'BLOCKED';
    when others then
      outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('old-style schedule write on a completed job|BLOCKED|%s', outcome);

    -- 5. Bookkeeping on a completed job's booking still works.
    begin
      update job_bookings set google_event_id = '0096-event' where id = b;
      outcome := 'ALLOWED';
    exception when others then
      outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('google_event_id on a completed job''s booking|ALLOWED|%s', outcome);

    perform set_config('role', 'postgres', true);

    -- 6. A flag-only write (what sync_window_refresh() does) still works.
    begin
      update job_bookings set sync_office = false where id = b;
      update jobs set sync_office = false, sync_tech = false where id = j_done;
      outcome := 'ALLOWED';
    exception when others then
      outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('flag-only write on a completed job and its booking|ALLOWED|%s', outcome);
    res := res || format('flag-only write landed|false|%s', (select sync_office from job_bookings where id = b));

    -- 7. The nightly refresh itself runs clean with closed jobs present.
    begin
      perform sync_window_refresh();
      outcome := 'ALLOWED';
    exception when others then
      outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('sync_window_refresh() with a completed job|ALLOWED|%s', outcome);

    perform set_config('role', 'authenticated', true);

    -- 8. Deleting one booking of a completed job works — the job's window is
    --    re-derived from the other one (a 0079 echo, which must pass).
    begin
      delete from job_bookings where id = b;
      outcome := 'ALLOWED';
    exception when others then
      outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('deleting a booking of a completed job|ALLOWED|%s', outcome);
    res := res || format('job window re-derived from the remaining booking|true|%s',
      (select scheduled_start = mon + interval '1 day' from jobs where id = j_done));

    -- 9. Clearing a completed job's schedule works (and removes its bookings).
    begin
      update jobs set scheduled_start = null, scheduled_end = null, schedule_daily = false, schedule_all_day = false where id = j_done;
      outcome := 'ALLOWED';
    exception when others then
      outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('clearing a completed job''s schedule|ALLOWED|%s', outcome);
    res := res || format('cleared job has no bookings|0|%s', (select count(*) from job_bookings where job_id = j_done));

    -- 10. Cancelled jobs are refused the same way.
    update jobs set status = 'cancelled' where id = j_cancel;
    begin
      insert into job_bookings (job_id, staff_id, starts_at, ends_at)
      values (j_cancel, null, mon, mon + interval '4 hours');
      outcome := 'ALLOWED';
    exception when sqlstate 'MJ001' then
      outcome := 'BLOCKED';
    when others then
      outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('new booking on a cancelled job|BLOCKED|%s', outcome);

    -- 11. Open jobs are untouched: book, move, old-style write.
    begin
      insert into job_bookings (job_id, staff_id, starts_at, ends_at)
      values (j_open, null, mon, mon + interval '4 hours') returning id into b;
      update job_bookings set ends_at = ends_at + interval '1 hour' where id = b;
      update jobs set scheduled_start = mon + interval '2 days', scheduled_end = mon + interval '2 days 4 hours' where id = j_open;
      outcome := 'ALLOWED';
    exception when others then
      outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('scheduling an open job|ALLOWED|%s', outcome);

    -- 12. Reopening and scheduling in one statement passes (NEW status counts).
    begin
      update jobs set status = 'scheduled', scheduled_start = mon, scheduled_end = mon + interval '4 hours' where id = j_done;
      outcome := 'ALLOWED';
    exception when others then
      outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('reopen + schedule in one write|ALLOWED|%s', outcome);
    select string_agg(status, ',') into state from jobs where id = j_done;
    res := res || format('reopened job is scheduled|scheduled|%s', state);

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
    raise exception E'% of % scenario(s) FAILED — scheduling closed jobs:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
