-- ============================================================================
-- GATE TEST for 0111 — Truck loads: the crew log loads on their own jobs and
-- nothing else, the included/extra defaults follow Justin's rules, a signed
-- load is locked, only the office invoices (extras only) or voids it, docket
-- costs are office-only and lock with the invoice, and only the office sets
-- the job's quarry default.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0111_cartage_loads_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Writes run as a real
-- technician, then a real office user, under the `authenticated` role, as the
-- apps do. Builds its own fixtures. Trust only the final "0111 PASSED" row:
-- any failure raises, the editor shows a red error, and nothing is kept.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  office uuid;
  cust uuid := gen_random_uuid();
  mine uuid := gen_random_uuid();
  theirs uuid := gen_random_uuid();
  quarry_job uuid := gen_random_uuid();
  truck uuid := gen_random_uuid();
  saw uuid := gen_random_uuid();
  spoil uuid := gen_random_uuid();
  rock uuid := gen_random_uuid();
  rock2 uuid := gen_random_uuid();
  inv uuid := gen_random_uuid();
  transport_centre uuid;
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
    select id into transport_centre from cost_centres where lower(btrim(name)) = 'transport';

    perform set_config('request.jwt.claims', '', true);
    insert into customers (id, name) values (cust, '0111 Customer');
    insert into jobs (id, customer_id, assigned_to, title) values (mine, cust, tech, '0111 mine');
    insert into jobs (id, customer_id, assigned_to, title, quarry_included) values (quarry_job, cust, tech, '0111 quarry extra', false);
    insert into jobs (id, customer_id, title) values (theirs, cust, '0111 theirs');
    insert into equipment (id, name, category) values (truck, 'ZZ 0111 Test Tipper', 'vehicle');
    insert into equipment (id, name, category) values (saw, 'ZZ 0111 Test Saw', 'tool');

    begin
      insert into equipment_hire_options (equipment_id, hire_type, hire_unit, rate) values (truck, 'cartage', 'tonne', 28);
      insert into equipment_hire_options (equipment_id, hire_type, hire_unit, rate) values (truck, 'cartage', 'm3', 40);
      insert into equipment_hire_options (equipment_id, hire_type, hire_unit, rate) values (truck, 'cartage', 'km', 3);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('truck rates per tonne, m3 and km|ALLOWED|%s', outcome);

    begin
      insert into equipment_hire_options (equipment_id, hire_type, hire_unit, rate) values (truck, 'wet', 'tonne', 1);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    end;
    res := res || format('per tonne on a wet hire (cartage only)|BLOCKED|%s', outcome);

    begin
      insert into hire_entries (job_id, equipment_id, hire_type, hire_unit, work_date)
        values (mine, truck, 'cartage', 'tonne', current_date);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    end;
    res := res || format('Day Works entry per tonne (truck loads only)|BLOCKED|%s', outcome);

    -- ---------------------------------------------------------------- technician
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);

    -- 1. Spoil out defaults to extra; the cost centre comes from the database.
    begin
      insert into cartage_loads (id, job_id, equipment_id, load_date, direction, place, quantity, unit, km, docket_number, cost_centre_id, docket_photo_path)
        values (spoil, mine, truck, current_date, 'spoil_out', 'Wollert tip', 12, 'tonne', 35, 'T1234', null, mine::text || '/x.jpg');
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('tech logs a spoil load on their job|ALLOWED|%s', outcome);
    select billing into v from cartage_loads where id = spoil;
    res := res || format('spoil out defaults to extra|extra|%s', coalesce(v, 'null'));
    select (cost_centre_id is not distinct from transport_centre)::text into v from cartage_loads where id = spoil;
    res := res || format('cost centre defaults to Transport|true|%s', coalesce(v, 'null'));
    select (docket_photo_path is null)::text into v from cartage_loads where id = spoil;
    res := res || format('crew cannot set the docket photo path themselves|true|%s', coalesce(v, 'null'));

    -- 2. Material in: included by default, extra when the job says so.
    insert into cartage_loads (id, job_id, equipment_id, load_date, direction, material, place, quantity, unit, km)
      values (rock, mine, truck, current_date, 'material_in', 'Crushed rock 20mm', 'Northern Quarries', 20, 'tonne', 40);
    select billing into v from cartage_loads where id = rock;
    res := res || format('quarry product defaults to included|included|%s', coalesce(v, 'null'));
    insert into cartage_loads (id, job_id, equipment_id, load_date, direction, material, quantity, unit)
      values (rock2, quarry_job, truck, current_date, 'material_in', 'Quarter minus', 18, 'tonne');
    select billing into v from cartage_loads where id = rock2;
    res := res || format('quarry product on a quarry-extra job defaults to extra|extra|%s', coalesce(v, 'null'));
    begin
      update cartage_loads set billing = 'extra' where id = rock;
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('driver switches a draft to extra|ALLOWED|%s', outcome);

    -- 3. Not on someone else's job; not a tool; not born signed.
    begin
      insert into cartage_loads (job_id, equipment_id, load_date, direction, quantity) values (theirs, truck, current_date, 'spoil_out', 10);
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('tech logs a load on a job they are not on|BLOCKED|%s', outcome);
    begin
      insert into cartage_loads (job_id, equipment_id, load_date, direction, quantity) values (mine, saw, current_date, 'spoil_out', 10);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('load on a tool, not a truck|BLOCKED|%s', outcome);
    begin
      insert into cartage_loads (job_id, equipment_id, load_date, direction, quantity, status, signer_name, signature_path)
        values (mine, truck, current_date, 'spoil_out', 10, 'signed', 'Rep', 'x/y.png');
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('load inserted already signed|BLOCKED|%s', outcome);

    -- 4. The crew cannot see or write costs, nor the job's quarry default.
    select count(*) into n from cartage_load_costs;
    res := res || format('tech reads docket costs|0|%s', n);
    begin
      insert into cartage_load_costs (load_id, docket_cost_ex_gst) values (spoil, 1);
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('tech enters a docket cost|BLOCKED|%s', outcome);
    begin
      update jobs set quarry_included = false where id = mine;
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('tech changes the job''s quarry default|BLOCKED|%s', outcome);

    -- 5. Sign-off needs a name, a signature and a quantity.
    begin
      update cartage_loads set status = 'signed', signer_name = 'Site Rep' where id = spoil;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('sign-off without a signature|BLOCKED|%s', outcome);
    begin
      update cartage_loads set status = 'signed', signer_name = 'Site Rep', signature_path = mine::text || '/day-works/sig.png'
       where id in (spoil, rock);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('builder''s rep signs the day''s extras at once|ALLOWED|%s', outcome);
    select count(*) into n from cartage_loads where id in (spoil, rock) and status = 'signed' and signed_by = tech and signed_at is not null;
    res := res || format('both stamped signed|2|%s', n);

    -- 6. Locked for the crew.
    update cartage_loads set quantity = 99 where id = spoil;
    get diagnostics n = row_count;
    res := res || format('tech changes the tonnes after signing|0|%s', n);
    delete from cartage_loads where id = spoil;
    get diagnostics n = row_count;
    res := res || format('tech deletes a signed load|0|%s', n);
    select count(*) into n from cartage_loads where job_id = mine;
    res := res || format('tech reads their job''s loads|2|%s', n);

    -- ---------------------------------------------------------------- office
    perform set_config('request.jwt.claims', json_build_object('sub', office::text, 'role', 'authenticated')::text, true);

    begin
      update cartage_loads set quantity = 99 where id = spoil;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('office changes the tonnes after signing|BLOCKED|%s', outcome);
    begin
      update cartage_loads set billing = 'included' where id = spoil;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('office flips a signed load to included|BLOCKED|%s', outcome);
    begin
      update cartage_loads set docket_photo_path = mine::text || '/expense-receipt-cartage-' || spoil::text || '-1.jpg' where id = spoil;
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('office attaches the docket photo after signing|ALLOWED|%s', outcome);

    begin
      insert into cartage_load_costs (load_id, docket_cost_ex_gst, margin_pct) values (spoil, 180, 20);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('office enters the tip fee|ALLOWED|%s', outcome);
    select (entered_by = office)::text into v from cartage_load_costs where load_id = spoil;
    res := res || format('entered_by stamped|true|%s', coalesce(v, 'null'));

    begin
      update jobs set quarry_included = false where id = mine;
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('office sets the job''s quarry default|ALLOWED|%s', outcome);

    insert into invoices (id, customer_id, job_id, title, status) values (inv, cust, mine, '0111 Day Works', 'draft');
    begin
      update cartage_loads set status = 'invoiced', invoice_id = inv where id = rock2;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('unsigned load invoiced|BLOCKED|%s', outcome);
    begin
      update cartage_loads set status = 'invoiced', invoice_id = inv where id = spoil;
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('office invoices a signed extra|ALLOWED|%s', outcome);

    begin
      update cartage_load_costs set docket_cost_ex_gst = 1 where load_id = spoil;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('docket cost changed after invoicing|BLOCKED|%s', outcome);

    delete from invoices where id = inv;
    select status into v from cartage_loads where id = spoil;
    res := res || format('deleting the invoice puts it back to signed|signed|%s', coalesce(v, 'null'));

    begin
      update cartage_loads set status = 'void', void_reason = '0111 test' where id = rock;
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('office voids a signed load|ALLOWED|%s', outcome);
    begin
      update cartage_loads set status = 'signed' where id = rock;
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('void load brought back|BLOCKED|%s', outcome);

    select count(*) into n from cartage_load_costs where load_id = spoil;
    res := res || format('office reads docket costs|1|%s', n);

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
    raise exception E'0111 gate FAILED — % of % scenario(s):%', n_fail, array_length(res, 1), failures;
  end if;
end;
$$;

select '0111 PASSED' as result;
