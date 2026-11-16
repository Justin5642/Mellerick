-- ============================================================================
-- GATE TEST for 0108 — Day Works / Hire: the crew can enter quantities on
-- their own jobs and nothing else, a signed entry is locked, only the office
-- invoices or voids it, and the rate tables are office-only.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0108_day_works_hire_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Writes run as a real
-- technician, then a real office user, under the `authenticated` role, as the
-- apps do. Builds its own fixtures; asserts nothing about the seeded rates,
-- which the office may edit. Trust only the final "0108 PASSED" row: any
-- failure raises, the editor shows a red error, and nothing is kept.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  office uuid;
  cust uuid := gen_random_uuid();
  mine uuid := gen_random_uuid();
  theirs uuid := gen_random_uuid();
  digger uuid := gen_random_uuid();
  floater uuid := gen_random_uuid();
  trencher uuid := gen_random_uuid();
  entry uuid := gen_random_uuid();
  entry2 uuid := gen_random_uuid();
  inv uuid := gen_random_uuid();
  wet_centre uuid;
  float_centre uuid;
  n int;
  v text;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into tech from profiles where role = 'technician' and coalesce(is_active, true) limit 1;
    select id into office from profiles where role in ('office', 'admin') and coalesce(is_active, true) limit 1;
    if tech is null or office is null then
      raise exception 'fixture missing: need an active technician and an active office/admin user';
    end if;
    select id into wet_centre from cost_centres where lower(btrim(name)) = 'plant wet hire';
    select id into float_centre from cost_centres where lower(btrim(name)) = 'float moves';

    perform set_config('request.jwt.claims', '', true);
    insert into customers (id, name) values (cust, '0108 Customer');
    insert into jobs (id, customer_id, assigned_to, title) values (mine, cust, tech, '0108 mine');
    insert into jobs (id, customer_id, title) values (theirs, cust, '0108 theirs');
    insert into equipment (id, name, category) values (digger, 'ZZ 0108 Test Bobcat', 'machinery');
    insert into equipment (id, name, category) values (floater, 'ZZ 0108 Test Float', 'vehicle');
    insert into equipment_hire_options (equipment_id, hire_type, hire_unit, rate) values (digger, 'wet', 'hour', 115);
    insert into equipment_hire_options (equipment_id, hire_type, hire_unit, float_base, float_km_included, float_per_km)
      values (floater, 'float', 'move', 470, 30, 5);
    insert into hire_attachments (id, name, day_rate) values (trencher, 'ZZ 0108 Test Trencher', 200);

    begin
      insert into equipment_hire_options (equipment_id, hire_type, hire_unit, rate) values (digger, 'wet', 'day', 1);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    end;
    res := res || format('wet hire by the day (not a valid unit)|BLOCKED|%s', outcome);

    -- ---------------------------------------------------------------- technician
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);

    select count(*) into n from equipment_hire_options;
    res := res || format('tech reads hire rates|0|%s', n);
    select count(*) into n from hire_attachments;
    res := res || format('tech reads attachment rates|0|%s', n);

    -- 1. A draft on their own job, choosing a cost centre they may not choose.
    begin
      insert into hire_entries (id, job_id, equipment_id, hire_type, hire_unit, work_date, hours, description, cost_centre_id)
        values (entry, mine, digger, 'wet', 'hour', current_date, 6, 'Bulk dig', float_centre);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('tech adds a draft on their job|ALLOWED|%s', outcome);
    select (cost_centre_id = wet_centre)::text into v from hire_entries where id = entry;
    res := res || format('cost centre comes from the hire setup, not the operator|true|%s', coalesce(v, 'null'));

    -- 2. Not on someone else's job.
    begin
      insert into hire_entries (job_id, equipment_id, hire_type, hire_unit, work_date, hours)
        values (theirs, digger, 'wet', 'hour', current_date, 2);
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('tech adds an entry on a job they are not on|BLOCKED|%s', outcome);

    -- 3. Not born signed.
    begin
      insert into hire_entries (job_id, equipment_id, hire_type, hire_unit, work_date, hours, status, signer_name, signature_path)
        values (mine, digger, 'wet', 'hour', current_date - 1, 2, 'signed', 'Rep', 'x/y.png');
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('entry inserted already signed|BLOCKED|%s', outcome);

    -- 4. A hire the machine is not set up for.
    begin
      insert into hire_entries (job_id, equipment_id, hire_type, hire_unit, work_date, days)
        values (mine, digger, 'dry', 'day', current_date - 2, 1);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('hire type the machine is not set up for|BLOCKED|%s', outcome);

    -- 5. One line per machine per day on a job.
    begin
      insert into hire_entries (job_id, equipment_id, hire_type, hire_unit, work_date, hours)
        values (mine, digger, 'wet', 'hour', current_date, 1);
      outcome := 'ALLOWED';
    exception when unique_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('second line for the same machine and day|BLOCKED|%s', outcome);

    -- 6. A float may make two moves a day.
    begin
      insert into hire_entries (job_id, equipment_id, hire_type, hire_unit, work_date, km)
        values (mine, floater, 'float', 'move', current_date, 50), (mine, floater, 'float', 'move', current_date, 12);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('two float moves the same day|ALLOWED|%s', outcome);

    -- 7. Attachments while a draft.
    begin
      insert into hire_entry_attachments (entry_id, attachment_id) values (entry, trencher);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('tech ticks an attachment on a draft|ALLOWED|%s', outcome);

    -- 8. Sign-off needs a name and a signature.
    begin
      update hire_entries set status = 'signed', signer_name = 'Site Rep' where id = entry;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('sign-off without a signature|BLOCKED|%s', outcome);

    begin
      update hire_entries set status = 'signed', signer_name = 'Site Rep', signature_path = mine::text || '/day-works/sig.png'
       where id = entry;
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('builder''s rep signs it off|ALLOWED|%s', outcome);
    select (signed_at is not null and signed_by = tech)::text into v from hire_entries where id = entry;
    res := res || format('signed_at and signed_by stamped|true|%s', coalesce(v, 'null'));

    -- 9. Locked for the crew.
    update hire_entries set hours = 9 where id = entry;
    get diagnostics n = row_count;
    res := res || format('tech changes hours after signing|0|%s', n);
    delete from hire_entries where id = entry;
    get diagnostics n = row_count;
    res := res || format('tech deletes a signed entry|0|%s', n);
    begin
      delete from hire_entry_attachments where entry_id = entry;
      get diagnostics n = row_count;
      outcome := case when n = 0 then 'BLOCKED' else 'ALLOWED' end;
    exception when check_violation then outcome := 'BLOCKED';
    end;
    res := res || format('tech removes an attachment after signing|BLOCKED|%s', outcome);

    -- 10. The crew still read it.
    select count(*) into n from hire_entries where job_id = mine;
    res := res || format('tech reads their job''s entries|3|%s', n);

    -- ---------------------------------------------------------------- office
    perform set_config('request.jwt.claims', json_build_object('sub', office::text, 'role', 'authenticated')::text, true);

    begin
      update hire_entries set hours = 9 where id = entry;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('office changes hours after signing|BLOCKED|%s', outcome);

    begin
      update hire_entries set status = 'invoiced' where id = entry;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('invoiced without an invoice|BLOCKED|%s', outcome);

    insert into invoices (id, customer_id, job_id, title, status) values (inv, cust, mine, '0108 Day Works', 'draft');
    begin
      update hire_entries set status = 'invoiced', invoice_id = inv where id = entry;
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('office marks it invoiced|ALLOWED|%s', outcome);

    delete from invoices where id = inv;
    select status into v from hire_entries where id = entry;
    res := res || format('deleting the invoice puts it back to signed|signed|%s', coalesce(v, 'null'));

    begin
      update hire_entries set status = 'void', void_reason = '0108 test' where id = entry;
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('office voids a signed entry|ALLOWED|%s', outcome);

    begin
      update hire_entries set status = 'signed' where id = entry;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('void entry brought back|BLOCKED|%s', outcome);

    -- A void line frees the machine-day for a corrected entry.
    begin
      insert into hire_entries (id, job_id, equipment_id, hire_type, hire_unit, work_date, hours)
        values (entry2, mine, digger, 'wet', 'hour', current_date, 7);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('new entry after voiding the old one|ALLOWED|%s', outcome);

    select count(*) into n from equipment_hire_options where equipment_id = digger;
    res := res || format('office reads hire rates|1|%s', n);

    perform set_config('request.jwt.claims', '', true);
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
    raise exception E'0108 gate FAILED — % of % scenario(s):%', n_fail, array_length(res, 1), failures;
  end if;
end;
$$;

select '0108 PASSED' as result;
