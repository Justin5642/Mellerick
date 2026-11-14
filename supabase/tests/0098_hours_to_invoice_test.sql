-- ============================================================================
-- REGRESSION TEST for 0098 — hours reach the invoice, billed hours are locked,
-- and completing a job always sends it to Approvals.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0098_hours_to_invoice_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Writes run as a real
-- technician / office user under the `authenticated` role, as the apps do.
--
-- SIDE EFFECT: the fixture inserts four jobs and one invoice; jobs.job_number
-- and invoices.invoice_number are serials, so the next real numbers skip ahead.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  off uuid;
  cust uuid := gen_random_uuid();
  j_hours uuid := gen_random_uuid();     -- assigned to tech, has hours, gets invoiced
  j_imported uuid := gen_random_uuid();  -- inserted 'approved', like a Simpro import
  j_rejected uuid := gen_random_uuid();  -- sent back, then completed again
  j_other uuid := gen_random_uuid();     -- someone else's hours
  inv uuid := gen_random_uuid();
  te1 uuid := gen_random_uuid();
  te2 uuid := gen_random_uuid();
  te_other uuid := gen_random_uuid();
  te_open uuid := gen_random_uuid();
  te_labour uuid := gen_random_uuid(); -- already priced by a pre-0086 auto Labour line
  result jsonb;
  outcome text;
  state text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into tech from profiles where role = 'technician' and coalesce(is_active, true) limit 1;
    select id into off from profiles where role in ('office', 'admin') and coalesce(is_active, true)
      order by (role = 'office') desc limit 1;
    if tech is null or off is null then
      raise exception 'fixture missing: need an active technician and an office user or admin';
    end if;

    -- Fixtures as postgres, no JWT.
    perform set_config('request.jwt.claims', '', true);
    insert into customers (id, name) values (cust, '0098 Customer');
    insert into jobs (id, customer_id, assigned_to, title, status) values (j_hours, cust, tech, '0098 hours job', 'in_progress');
    insert into jobs (id, customer_id, assigned_to, title, status, admin_status)
      values (j_imported, cust, tech, '0098 imported job', 'in_progress', 'approved');
    insert into jobs (id, customer_id, assigned_to, title, status, admin_status)
      values (j_rejected, cust, tech, '0098 sent-back job', 'in_progress', 'rejected');
    insert into jobs (id, customer_id, title, status) values (j_other, cust, '0098 other job', 'completed');
    insert into time_entries (id, job_id, staff_id, clock_in, clock_out, hours, entry_type)
      values (te_other, j_other, off, now() - interval '9 hours', now() - interval '8 hours', 1, 'work');
    insert into invoices (id, customer_id, job_id, title, status, subtotal, tax_amount, total)
      values (inv, cust, j_hours, '0098 invoice', 'draft', 0, 0, 0);
    insert into invoice_items (invoice_id, name, quantity, unit_price) values (inv, 'Materials', 1, 50);
    insert into time_entries (id, job_id, staff_id, clock_in, clock_out, hours, entry_type)
      values (te_labour, j_hours, tech, now() - interval '20 hours', now() - interval '19 hours', 1, 'work');
    insert into job_items (job_id, name, quantity, unit_price, source, time_entry_id)
      values (j_hours, 'Labour', 1, 130, 'auto_labour', te_labour);

    perform set_config('role', 'authenticated', true);

    -- ---- As the technician -------------------------------------------------
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);

    -- Clock on/off, then correct it (the manual adjustment).
    insert into time_entries (id, job_id, staff_id, clock_in, clock_out, hours, entry_type)
      values (te1, j_hours, tech, now() - interval '6 hours', now() - interval '3 hours', 3, 'work');
    update time_entries set clock_out = clock_in + interval '3 hours 30 minutes', hours = 3.5 where id = te1;
    insert into time_entries (id, job_id, staff_id, clock_in, clock_out, hours, entry_type)
      values (te2, j_hours, tech, now() - interval '2 hours', now() - interval '1 hour', 1, 'work');
    insert into time_entries (id, job_id, staff_id, clock_in, entry_type)
      values (te_open, j_hours, tech, now() - interval '10 minutes', 'work');

    -- 1. A technician cannot bill hours.
    begin
      update time_entries set invoice_id = inv where id = te2;
      outcome := 'ALLOWED';
    exception when sqlstate '42501' then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('tech sets invoice_id on own entry|BLOCKED|%s', outcome);

    begin
      insert into time_entries (job_id, staff_id, clock_in, clock_out, hours, entry_type, invoice_id)
        values (j_hours, tech, now() - interval '30 hours', now() - interval '29 hours', 1, 'work', inv);
      outcome := 'ALLOWED';
    exception when sqlstate '42501' then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('tech inserts an entry already billed|BLOCKED|%s', outcome);

    begin
      perform apply_invoice_hours(inv, jsonb_build_array(jsonb_build_object(
        'name', 'Labour', 'quantity', 1, 'unit_price', 1, 'entry_ids', jsonb_build_array(te2))));
      outcome := 'ALLOWED';
    exception when sqlstate '42501' then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('tech calls apply_invoice_hours|BLOCKED|%s', outcome);

    -- 2. Completing a job sends it to Approvals, whatever its approval state was.
    update jobs set status = 'completed' where id = j_hours;
    update jobs set status = 'completed' where id = j_imported;
    update jobs set status = 'completed' where id = j_rejected;
    select admin_status into state from jobs where id = j_hours;
    res := res || format('new job completed|pending|%s', state);
    select admin_status into state from jobs where id = j_imported;
    res := res || format('imported approved job completed again|pending|%s', state);
    select admin_status into state from jobs where id = j_rejected;
    res := res || format('sent-back job completed again|pending|%s', state);

    -- 3. The new column is readable by the apps (column grants re-applied).
    res := res || format('invoice_id readable by authenticated|true|%s',
      has_column_privilege('authenticated', 'public.time_entries', 'invoice_id', 'SELECT'));
    res := res || format('rate_override still hidden|false|%s',
      has_column_privilege('authenticated', 'public.time_entries', 'rate_override', 'SELECT'));

    -- ---- As the office -----------------------------------------------------
    perform set_config('request.jwt.claims', json_build_object('sub', off::text, 'role', 'authenticated')::text, true);

    -- 4. Office approves (as the app does after this migration).
    update jobs set admin_status = 'approved' where id = j_hours;
    select admin_status into state from jobs where id = j_hours;
    res := res || format('office approves|approved|%s', state);

    -- 5. Another job's hours, or a still-open entry, are refused.
    begin
      perform apply_invoice_hours(inv, jsonb_build_array(jsonb_build_object(
        'name', 'Labour', 'quantity', 1, 'unit_price', 100, 'entry_ids', jsonb_build_array(te_other))));
      outcome := 'ALLOWED';
    exception when sqlstate '22023' then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('billing another job''s hours|BLOCKED|%s', outcome);

    begin
      perform apply_invoice_hours(inv, jsonb_build_array(jsonb_build_object(
        'name', 'Labour', 'quantity', 1, 'unit_price', 100, 'entry_ids', jsonb_build_array(te_open))));
      outcome := 'ALLOWED';
    exception when sqlstate '22023' then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('billing an open entry|BLOCKED|%s', outcome);

    begin
      perform apply_invoice_hours(inv, jsonb_build_array(jsonb_build_object(
        'name', 'Labour', 'quantity', 1, 'unit_price', 100, 'entry_ids', jsonb_build_array(te_labour))));
      outcome := 'ALLOWED';
    exception when sqlstate '22023' then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('billing hours an auto Labour line already covers|BLOCKED|%s', outcome);

    -- 6. Office bills both closed entries: 3.5h + 1h at $130 = $585, + $50 materials.
    result := apply_invoice_hours(inv, jsonb_build_array(
      jsonb_build_object('name', 'Labour', 'description', 'Tech: 3.50h @ $130.00/hr', 'quantity', 3.5, 'unit_price', 130, 'entry_ids', jsonb_build_array(te1)),
      jsonb_build_object('name', 'Labour', 'description', 'Tech: 1.00h @ $130.00/hr', 'quantity', 1, 'unit_price', 130, 'entry_ids', jsonb_build_array(te2))
    ));
    res := res || format('lines written|2|%s', result->>'lines');
    res := res || format('entries linked|2|%s', result->>'entries');
    res := res || format('subtotal|635.00|%s', (select subtotal from invoices where id = inv));
    res := res || format('gst|63.50|%s', (select tax_amount from invoices where id = inv));
    res := res || format('total|698.50|%s', (select total from invoices where id = inv));
    res := res || format('open entry left unbilled|true|%s', (select invoice_id is null from time_entries where id = te_open));

    -- 7. Re-applying at a new rate replaces the hours lines, never duplicates.
    perform apply_invoice_hours(inv, jsonb_build_array(
      jsonb_build_object('name', 'Labour', 'quantity', 4.5, 'unit_price', 100, 'entry_ids', jsonb_build_array(te1, te2))
    ));
    res := res || format('hours lines after re-apply|1|%s', (select count(*) from invoice_items where invoice_id = inv and source = 'hours'));
    res := res || format('hand-typed line kept|1|%s', (select count(*) from invoice_items where invoice_id = inv and source is null));
    res := res || format('total after re-apply|550.00|%s', (select total from invoices where id = inv));

    -- ---- Back as the technician: billed hours are locked --------------------
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    begin
      update time_entries set clock_out = clock_out + interval '1 hour' where id = te1;
      outcome := 'ALLOWED';
    exception when sqlstate '42501' then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('tech edits a billed entry|BLOCKED|%s', outcome);

    begin
      update time_entries set clock_out = now() where id = te_open;
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('tech clocks off an unbilled entry|ALLOWED|%s', outcome);

    -- ---- Service role (import scripts): history is not re-queued -------------
    perform set_config('request.jwt.claims', '', true);
    perform set_config('role', 'postgres', true);
    update jobs set status = 'in_progress', admin_status = 'approved' where id = j_imported;
    update jobs set status = 'completed' where id = j_imported;
    select admin_status into state from jobs where id = j_imported;
    res := res || format('service-role completion leaves approval alone|approved|%s', state);

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
    raise exception E'% of % scenario(s) FAILED — hours to invoice:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
