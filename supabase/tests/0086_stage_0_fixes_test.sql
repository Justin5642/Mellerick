-- ============================================================================
-- REGRESSION TEST for 0086 — Stage 0 fixes.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0086_stage_0_fixes_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  j uuid;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into j from jobs limit 1;
    if j is null then
      raise exception 'fixture missing: need a job';
    end if;

    -- 1. A Project job saves; a made-up type still does not.
    begin
      update jobs set job_type = 'project' where id = j;
      outcome := 'ALLOWED';
    exception when check_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('project job type|ALLOWED|%s', outcome);
    begin
      update jobs set job_type = 'not-a-type' where id = j;
      outcome := 'ALLOWED';
    exception when check_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('unknown job type|BLOCKED|%s', outcome);
    res := res || format('one job_type check|1|%s', (
      select count(*) from pg_constraint
      where conrelid = 'public.jobs'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) ilike '%job_type%'));

    -- 2. Automatic labour lines are off.
    res := res || format('auto labour lines off|f|%s', (select auto_labour_lines from billing_rate_config where id));

    -- 3. Margin flag at 20%.
    res := res || format('min margin 20|20.00|%s', (select min_margin_pct from billing_rate_config where id));

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
    raise exception E'% of % scenario(s) FAILED — stage 0 fixes:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
