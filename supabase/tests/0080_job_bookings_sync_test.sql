-- ============================================================================
-- REGRESSION TEST for 0080 — job_bookings on devices: the publication, the
-- office window flag, and the flag-only writes that must NOT count as
-- activity (the reason 0080 re-hangs 0079's triggers).
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0080_job_bookings_sync_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. The window refresh
-- runs inside it (over the whole database) and is undone with everything else.
--
-- SIDE EFFECT: the fixture inserts two jobs; jobs.job_number is a serial, so
-- the next real job skips two numbers.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  off uuid;
  cust uuid := gen_random_uuid();
  j uuid := gen_random_uuid();
  j_old uuid := gen_random_uuid();
  b uuid;
  b_old uuid;
  mon timestamptz := date_trunc('day', now()) + interval '7 days 7 hours';
  long_ago timestamptz := now() - interval '3 years';
  replica_ok boolean := true;
  job_ctid text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
  r record;
begin
  begin
    select id into off from profiles where role in ('office', 'admin') and coalesce(is_active, true)
      order by (role = 'office') desc limit 1;
    if off is null then
      raise exception 'fixture missing: need an office user or admin';
    end if;

    perform set_config('request.jwt.claims', json_build_object('sub', off::text, 'role', 'authenticated')::text, true);
    insert into customers (id, name) values (cust, '0080 Customer');
    insert into jobs (id, customer_id, title) values (j, cust, '0080 open job');
    -- Unassigned (staff_id null): no crew row, so no assignment push fires.
    insert into job_bookings (job_id, staff_id, starts_at, ends_at)
    values (j, null, mon, mon + interval '4 hours') returning id into b;
    -- A closed job last touched three years ago, with its booking.
    insert into jobs (id, customer_id, title, status) values (j_old, cust, '0080 old job', 'completed');
    insert into job_bookings (job_id, staff_id, starts_at, ends_at, created_at)
    values (j_old, null, long_ago, long_ago + interval '4 hours', long_ago) returning id into b_old;

    -- now() is constant inside this one transaction, so "updated_at was not
    -- bumped" can only be observed against a value that is NOT now(). Backdate
    -- past the triggers that would stamp it, which needs
    -- session_replication_role; where this role may not set it, the
    -- timestamp scenarios are reported as skipped rather than guessed.
    begin
      perform set_config('session_replication_role', 'replica', true);
      update jobs set created_at = long_ago, updated_at = long_ago where id in (j, j_old);
      update job_bookings set updated_at = long_ago where id in (b, b_old);
      perform set_config('session_replication_role', 'origin', true);
    exception when insufficient_privilege then
      replica_ok := false;
      raise notice 'skipping the timestamp scenarios: this role cannot set session_replication_role';
    end;

    -- 1. Replicated at all.
    res := res || format('job_bookings is in the powersync publication|true|%s',
      exists (select 1 from pg_publication_tables
               where pubname = 'powersync' and schemaname = 'public' and tablename = 'job_bookings'));

    -- 2. New rows are in the office window.
    res := res || format('new booking is in the office window|true|%s',
      (select sync_office from job_bookings where id = b));

    -- 3. A client cannot hide a booking from office devices.
    perform set_config('role', 'authenticated', true);
    update job_bookings set sync_office = false where id = b;
    perform set_config('role', 'postgres', true);
    res := res || format('client write of sync_office=false is ignored|true|%s',
      (select sync_office from job_bookings where id = b));

    -- 4. A trusted flag-only write (what the nightly refresh does) stays put
    --    and is NOT activity: no updated_at bump on the booking or its job, no
    --    re-derive of the job, no rebuild of its bookings. Under 0079's
    --    triggers alone each of these failed.
    -- The job row's physical address (ctid) changes on ANY update, so it shows
    -- a re-derive even inside this one transaction, where now() — and so
    -- updated_at — cannot move. Needs no special privilege.
    select ctid::text into job_ctid from jobs where id = j;
    update job_bookings set sync_office = false where id = b;
    select * into r from job_bookings where id = b;
    res := res || format('refresh-style write: booking leaves the window|false|%s', r.sync_office);
    res := res || format('refresh-style write: job not re-derived (row untouched)|%s|%s',
      job_ctid, (select ctid::text from jobs where id = j));
    res := res || format('refresh-style write: bookings not rebuilt|%s|%s',
      b, (select string_agg(id::text, ',') from job_bookings where job_id = j));
    if replica_ok then
      res := res || format('refresh-style write: booking updated_at kept|%s|%s', long_ago, r.updated_at);
      res := res || format('refresh-style write: job updated_at kept|%s|%s',
        long_ago, (select updated_at from jobs where id = j));
    end if;

    -- 5. The job coming back in-window brings its bookings back (cascade).
    update jobs set sync_office = false where id = j;
    update jobs set sync_office = true where id = j;
    res := res || format('job back in-window cascades to its booking|true|%s',
      (select sync_office from job_bookings where id = b));

    -- 6. A real office edit to an out-of-window booking brings it, and its
    --    job, back.
    update job_bookings set sync_office = false where id = b;
    update jobs set sync_office = false where id = j;
    perform set_config('role', 'authenticated', true);
    update job_bookings set ends_at = ends_at + interval '1 hour' where id = b;
    perform set_config('role', 'postgres', true);
    res := res || format('real edit: booking back in-window|true|%s',
      (select sync_office from job_bookings where id = b));
    res := res || format('real edit: its job back in-window|true|%s',
      (select sync_office from jobs where id = j));
    if replica_ok then
      res := res || format('real edit: booking updated_at moves|true|%s',
        (select updated_at > long_ago from job_bookings where id = b));
    end if;

    -- 7. The refresh keeps an open job's booking in, and ages out a closed,
    --    3-year-old job's booking WITHOUT touching the job (the job's
    --    updated_at is what decides its window, so a refresh that bumped it
    --    would keep the job in forever).
    perform sync_window_refresh();
    res := res || format('refresh keeps an open job''s booking|true|%s',
      (select sync_office from job_bookings where id = b));
    if replica_ok then
      res := res || format('refresh ages out an old closed job|false|%s',
        (select sync_office from jobs where id = j_old));
      res := res || format('refresh ages out an old closed job''s booking|false|%s',
        (select sync_office from job_bookings where id = b_old));
      res := res || format('refresh leaves the old job''s updated_at alone|%s|%s',
        long_ago, (select updated_at from jobs where id = j_old));
    end if;

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
    raise exception E'% of % scenario(s) FAILED — job bookings sync:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
