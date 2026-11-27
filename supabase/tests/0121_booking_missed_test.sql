-- ============================================================================
-- GATE TEST for 0121 — "Didn't make it" on a booking.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0121_booking_missed_test.sql
--   or paste the whole file into the Supabase SQL editor AFTER 0121.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Calls run as a real
-- technician, then a real office/admin user, under the `authenticated` role,
-- as the app does. Builds its own fixtures. Trust only the final
-- "0121 PASSED" row: any failure raises, the editor shows a red error, and
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
  job_c uuid := gen_random_uuid();   -- completed after its booking is made
  b_today uuid := gen_random_uuid();
  b_past uuid := gen_random_uuid();
  b_future uuid := gen_random_uuid();
  b_other uuid := gen_random_uuid();  -- the office user's own booking
  b_done uuid := gen_random_uuid();
  today date := (now() at time zone 'Australia/Melbourne')::date;
  at7 timestamptz;
  bk job_bookings;
  j_start timestamptz;
  j_end timestamptz;
  n int;
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
    at7 := (today::timestamp + interval '7 hours') at time zone 'Australia/Melbourne';

    -- Fixtures as the service role (bookings put people on the crew — 0074).
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    insert into customers (id, name) values (cust, '0121 Customer');
    insert into jobs (id, customer_id, title, status) values (job_a, cust, '0121 job A', 'scheduled');
    insert into jobs (id, customer_id, title, status) values (job_c, cust, '0121 job C', 'scheduled');
    insert into job_bookings (id, job_id, staff_id, starts_at, ends_at)
      values (b_today, job_a, tech, at7, at7 + interval '8 hours 30 minutes');
    insert into job_bookings (id, job_id, staff_id, starts_at, ends_at)
      values (b_past, job_a, tech, at7 - interval '3 days', at7 - interval '3 days' + interval '4 hours');
    insert into job_bookings (id, job_id, staff_id, starts_at, ends_at)
      values (b_future, job_a, tech, at7 + interval '3 days', at7 + interval '3 days' + interval '4 hours');
    insert into job_bookings (id, job_id, staff_id, starts_at, ends_at)
      values (b_other, job_a, office, at7, at7 + interval '2 hours');
    insert into job_bookings (id, job_id, staff_id, starts_at, ends_at)
      values (b_done, job_c, tech, at7 - interval '1 day', at7 - interval '1 day' + interval '4 hours');
    update jobs set status = 'completed' where id = job_c;
    select scheduled_start, scheduled_end into j_start, j_end from jobs where id = job_a;

    -- Take the technician off job A's crew WITHOUT 0079 rebuilding anything, so
    -- a re-derive of the job (which re-adds every booked technician) shows.
    perform set_config('app.booking_sync', 'on', true);
    delete from job_assignments where job_id = job_a and staff_id = tech;
    perform set_config('app.booking_sync', '', true);

    res := res || format('anon may run flag_booking_missed|false|%s',
      has_function_privilege('anon', 'public.flag_booking_missed(uuid, text, text)', 'execute'));
    res := res || format('anon may run clear_booking_missed|false|%s',
      has_function_privilege('anon', 'public.clear_booking_missed(uuid)', 'execute'));
    res := res || format('authenticated may run the shared check directly|false|%s',
      has_function_privilege('authenticated', 'public.booking_missed_target(uuid)', 'execute'));

    -- ---------------------------------------------------------------- technician
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);

    begin
      update job_bookings set missed_at = now(), missed_by = tech, missed_reason = 'weather' where id = b_today;
      get diagnostics n = row_count;
      outcome := case when n = 0 then 'BLOCKED' else 'ALLOWED' end;
    exception when insufficient_privilege then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician writes the missed columns directly|BLOCKED|%s', outcome);

    begin
      perform flag_booking_missed(b_today, 'other', '  ');
      outcome := 'ALLOWED';
    exception when others then outcome := sqlstate;
    end;
    res := res || format('Other without a note refused|MJ147|%s', outcome);

    begin
      perform flag_booking_missed(b_today, 'lunch', null);
      outcome := 'ALLOWED';
    exception when others then outcome := sqlstate;
    end;
    res := res || format('an unknown reason refused|MJ146|%s', outcome);

    begin
      perform flag_booking_missed(b_today, 'weather', repeat('x', 501));
      outcome := 'ALLOWED';
    exception when others then outcome := sqlstate;
    end;
    res := res || format('a 501-character note refused|MJ148|%s', outcome);

    begin
      perform flag_booking_missed(b_other, 'weather', null);
      outcome := 'ALLOWED';
    exception when others then outcome := sqlstate;
    end;
    res := res || format('technician flags someone else''s booking|MJ142|%s', outcome);

    begin
      perform flag_booking_missed(b_future, 'weather', null);
      outcome := 'ALLOWED';
    exception when others then outcome := sqlstate;
    end;
    res := res || format('a future booking can''t be flagged|MJ144|%s', outcome);

    begin
      perform flag_booking_missed(b_done, 'weather', null);
      outcome := 'ALLOWED';
    exception when others then outcome := sqlstate;
    end;
    res := res || format('a completed job''s booking can''t be flagged|MJ001|%s', outcome);

    begin
      bk := flag_booking_missed(b_today, 'weather', '  rained out  ');
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician flags their own booking today|ALLOWED|%s', outcome);
    -- (the function's answer: the technician is off the crew here, so RLS 0107 hides the row from a read)
    res := res || format('reason stored|weather|%s', coalesce(bk.missed_reason, 'null'));
    res := res || format('note stored trimmed|rained out|%s', coalesce(bk.missed_note, 'null'));
    res := res || format('flagged by the technician|true|%s', (bk.missed_by = tech and bk.missed_at is not null));
    res := res || format('the booking stays where it is|true|%s', (bk.starts_at = at7 and bk.staff_id = tech));

    select count(*) into n from job_assignments where job_id = job_a and staff_id = tech;
    res := res || format('the flag didn''t re-derive the job (crew untouched)|0|%s', n);

    begin
      perform flag_booking_missed(b_past, 'out_of_time', null);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlstate;
    end;
    res := res || format('technician flags an earlier booking|ALLOWED|%s', outcome);

    begin
      perform flag_booking_missed(b_today, 'weather', 'rained out');
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlstate;
    end;
    res := res || format('the same flag again (a retry)|ALLOWED|%s', outcome);

    begin
      perform clear_booking_missed(b_past);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlstate;
    end;
    res := res || format('technician undoes their own flag|ALLOWED|%s', outcome);
    select missed_reason into outcome from job_bookings where id = b_past;
    res := res || format('…and it is gone|null|%s', coalesce(outcome, 'null'));

    -- ---------------------------------------------------------------- office
    perform set_config('request.jwt.claims', json_build_object('sub', office::text, 'role', 'authenticated')::text, true);
    begin
      perform flag_booking_missed(b_past, 'site_not_ready', null);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('office flags a technician''s booking|ALLOWED|%s', outcome);
    begin
      perform clear_booking_missed(b_past);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlstate;
    end;
    res := res || format('office clears it|ALLOWED|%s', outcome);
    select missed_reason into outcome from job_bookings where id = b_past;
    res := res || format('…and it is gone|null|%s', coalesce(outcome, 'null'));

    select scheduled_start, scheduled_end into bk.starts_at, bk.ends_at from jobs where id = job_a;
    res := res || format('the job''s window is unchanged by flags|true|%s',
      (bk.starts_at is not distinct from j_start and bk.ends_at is not distinct from j_end));

    -- The office reschedules the flagged booking: it moves a day on.
    update job_bookings set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day' where id = b_today;
    select * into bk from job_bookings where id = b_today;
    res := res || format('moving the booking clears the flag|true|%s',
      (bk.missed_reason is null and bk.missed_at is null and bk.missed_by is null and bk.missed_note is null));

    -- …or gives it to someone else.
    perform flag_booking_missed(b_past, 'unavailable', null);
    update job_bookings set staff_id = office where id = b_past;
    select missed_reason into outcome from job_bookings where id = b_past;
    res := res || format('another technician clears the flag|null|%s', coalesce(outcome, 'null'));

    -- A note-only edit by the office keeps the flag.
    perform flag_booking_missed(b_other, 'previous_job_ran_over', null);
    update job_bookings set note = 'call first' where id = b_other;
    select missed_reason into outcome from job_bookings where id = b_other;
    res := res || format('a note edit keeps the flag|previous_job_ran_over|%s', coalesce(outcome, 'null'));

    -- ---------------------------------------------------------------- limited technician
    perform set_config('request.jwt.claims', '', true);
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    update profiles set limited_access = true where id = tech;
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    begin
      perform flag_booking_missed(b_today, 'weather', null);
      outcome := 'ALLOWED';
    exception when others then outcome := sqlstate;
    end;
    res := res || format('limited-access account refused|MJ142|%s', outcome);

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
    raise exception E'0121 gate FAILED — % of % scenario(s):%', n_fail, array_length(res, 1), failures;
  end if;
end;
$$;

select '0121 PASSED' as result;
