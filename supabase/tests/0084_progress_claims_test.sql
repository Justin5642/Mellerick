-- ============================================================================
-- REGRESSION TEST for 0084 — progress claim figures on invoices.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0084_progress_claims_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  inv uuid;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into inv from invoices limit 1;
    if inv is null then
      raise exception 'fixture missing: need an invoice';
    end if;

    -- 1. An ordinary invoice stays ordinary.
    res := res || format('existing invoices are not claims|false|%s', (select is_progress_claim from invoices where id = inv));

    -- 2. A complete claim saves.
    begin
      update invoices set is_progress_claim = true, claim_number = 2, claim_contract_value = 9200, claim_previous = 1000 where id = inv;
      outcome := 'ALLOWED';
    exception when check_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('complete progress claim|ALLOWED|%s', outcome);

    -- 3. A claim missing its contract value does not.
    begin
      update invoices set claim_contract_value = null where id = inv;
      outcome := 'ALLOWED';
    exception when check_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('claim without contract value|BLOCKED|%s', outcome);

    -- 4. Nor does an ordinary invoice carrying claim figures.
    begin
      update invoices set is_progress_claim = false where id = inv;
      outcome := 'ALLOWED';
    exception when check_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('non-claim keeping claim figures|BLOCKED|%s', outcome);

    -- 5. Turning it back into an ordinary invoice, cleanly.
    begin
      update invoices set is_progress_claim = false, claim_number = null, claim_contract_value = null, claim_previous = null where id = inv;
      outcome := 'ALLOWED';
    exception when check_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('back to ordinary invoice|ALLOWED|%s', outcome);

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
    raise exception E'% of % scenario(s) FAILED — progress claims:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
