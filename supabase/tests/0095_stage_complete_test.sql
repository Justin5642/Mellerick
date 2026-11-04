-- ============================================================================
-- REGRESSION TEST for 0095 — job stages marked complete.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0095_stage_complete_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  cc uuid;
  who uuid;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into cc from po_cost_centers limit 1;
    select id into who from profiles limit 1;
    if cc is null or who is null then
      raise exception 'fixture missing: need a cost centre line and a profile';
    end if;

    update po_cost_centers set completed_at = now(), completed_by = who where id = cc;
    res := res || format('stage marked complete|t|%s', (select completed_at is not null and completed_by = who from po_cost_centers where id = cc));

    -- Technicians still read stages only through the money-free view.
    res := res || format('techs' stage view still has no money|f|%s', exists (
      select 1 from information_schema.columns
      where table_name = 'po_cost_centers_public' and column_name in ('allocated_amount')));

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
    raise exception E'% of % scenario(s) FAILED — stage complete:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
