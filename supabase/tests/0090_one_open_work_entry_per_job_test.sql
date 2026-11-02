-- ============================================================================
-- REGRESSION TEST for 0090 — one open work entry per person per job.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0090_one_open_work_entry_per_job_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  j uuid;
  j2 uuid;
  st uuid;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into j from jobs order by created_at limit 1;
    select id into j2 from jobs where id <> j order by created_at limit 1;
    select id into st from profiles order by created_at limit 1;
    if j is null or st is null then
      raise exception 'fixture missing: need a job and a profile';
    end if;
    -- Start clean for this person on these jobs.
    update time_entries set clock_out = clock_in + interval '1 second' where staff_id = st and job_id in (j, j2) and clock_out is null;

    -- 1. No duplicates are left anywhere.
    res := res || format('duplicate open entries left|0|%s', (
      select count(*) from (
        select 1 from time_entries where clock_out is null and entry_type = 'work'
        group by staff_id, job_id having count(*) > 1) d));

    -- 2. A second open entry on the same job is refused.
    insert into time_entries (job_id, staff_id, clock_in, entry_type) values (j, st, now(), 'work');
    begin
      insert into time_entries (job_id, staff_id, clock_in, entry_type) values (j, st, now(), 'work');
      outcome := 'ALLOWED';
    exception when unique_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('second open entry same job|BLOCKED|%s', outcome);

    -- 3. Open on another job is fine; travel and closed entries are untouched.
    begin
      if j2 is not null then
        insert into time_entries (job_id, staff_id, clock_in, entry_type) values (j2, st, now(), 'work');
      end if;
      insert into time_entries (job_id, staff_id, clock_in, entry_type) values (j, st, now(), 'travel');
      insert into time_entries (job_id, staff_id, clock_in, clock_out, entry_type) values (j, st, now() - interval '2 hours', now() - interval '1 hour', 'work');
      outcome := 'ALLOWED';
    exception when unique_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('other job, travel and closed entries|ALLOWED|%s', outcome);

    raise exception using errcode = 'ZX001', message = 'undo test changes';
  exception when sqlstate 'ZX001' then
    null;
  end;

  if coalesce(array_length(res, 1), 0) = 0 then
    raise exception 'test recorded no scenarios';
  end if;
  foreach line in array res loop
    parts := string_to_array(line, '|');
    if parts[2] is distinct from parts[3] then
      n_fail := n_fail + 1;
      failures := failures || format(E'\n  - %s: expected %s, got %s', parts[1], parts[2], parts[3]);
    end if;
  end loop;
  if n_fail > 0 then
    raise exception E'% of % scenario(s) FAILED — one open entry:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
