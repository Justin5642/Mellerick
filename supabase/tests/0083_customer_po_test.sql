-- ============================================================================
-- REGRESSION TEST for 0083 — customer PO number on jobs and invoices.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0083_customer_po_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  j uuid;
  inv uuid;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into j from jobs limit 1;
    select id into inv from invoices limit 1;
    if j is null or inv is null then
      raise exception 'fixture missing: need a job and an invoice';
    end if;

    -- 1. A PO number saves on a job and an invoice.
    update jobs set customer_po = 'PO-4500123' where id = j;
    update invoices set customer_po = 'PO-4500123' where id = inv;
    res := res || format('job keeps its PO|PO-4500123|%s', (select customer_po from jobs where id = j));
    res := res || format('invoice keeps its PO|PO-4500123|%s', (select customer_po from invoices where id = inv));

    -- 2. Cleared is NULL, not ''.
    begin
      update invoices set customer_po = '' where id = inv;
      outcome := 'ALLOWED';
    exception when check_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('empty PO string|BLOCKED|%s', outcome);

    -- 3. Too long for the Xero reference.
    begin
      update jobs set customer_po = repeat('9', 61) where id = j;
      outcome := 'ALLOWED';
    exception when check_violation then
      outcome := 'BLOCKED';
    end;
    res := res || format('61-character PO|BLOCKED|%s', outcome);

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
    raise exception E'% of % scenario(s) FAILED — customer PO:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
