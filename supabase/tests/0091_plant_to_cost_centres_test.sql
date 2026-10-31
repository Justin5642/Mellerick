-- ============================================================================
-- REGRESSION TEST for 0091 — plant usage to cost centres, loads.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0091_plant_to_cost_centres_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  eq uuid := gen_random_uuid();
  j uuid;
  cc uuid;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select cc_.id, po.job_id into cc, j
      from po_cost_centers cc_ join purchase_orders po on po.id = cc_.po_id limit 1;
    if cc is null then
      raise exception 'fixture missing: need a job with a PO cost centre';
    end if;
    insert into equipment (id, name, category, cost_per_load) values (eq, 'Test Truck 0091', 'vehicle', 85);

    -- 1. Loads only, on the job's cost centre line.
    begin
      insert into equipment_usage_log (equipment_id, job_id, hours, loads, cost_center_id) values (eq, j, 0, 3, cc);
      outcome := 'ALLOWED';
    exception when check_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('loads-only usage on a cost centre|ALLOWED|%s', outcome);

    -- 2. Nothing used is refused; negative loads refused.
    begin
      insert into equipment_usage_log (equipment_id, job_id, hours, loads) values (eq, j, 0, 0);
      outcome := 'ALLOWED';
    exception when check_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('zero hours and zero loads|BLOCKED|%s', outcome);
    begin
      insert into equipment_usage_log (equipment_id, job_id, hours, loads) values (eq, j, 1, -1);
      outcome := 'ALLOWED';
    exception when check_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('negative loads|BLOCKED|%s', outcome);

    -- 3. Cost per load saved.
    res := res || format('cost per load|85.00|%s', (select cost_per_load from equipment where id = eq));

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
    raise exception E'% of % scenario(s) FAILED — plant to cost centres:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
