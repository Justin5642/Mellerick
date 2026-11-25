-- ============================================================================
-- GATE TEST for 0119 — mistake tracking: the crew raise through one door and
-- read only their own, money-free; the money tables stay office/admin; whose
-- mistake is admin only; links name real costs on the same job, once; the
-- 0115 amount and its legacy line stay in step.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0119_mistake_tracking_test.sql
--   or paste the whole file into the Supabase SQL editor AFTER 0119.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Writes run as a
-- real technician, office user and admin under the `authenticated` role, as
-- the app does. Builds its own fixtures. Trust only the final "0119 PASSED"
-- row: any failure raises, the editor shows a red error, and nothing is kept.
--
-- Needs an active technician and an active admin. The office-only checks run
-- when an active office user exists (otherwise the admin stands in for the
-- office and the "office can't see whose mistake" checks are skipped).
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  office uuid;
  admin_id uuid;
  has_office boolean;
  cust uuid := gen_random_uuid();
  job_a uuid := gen_random_uuid();
  job_b uuid := gen_random_uuid();
  po_a uuid := gen_random_uuid();
  po_b uuid := gen_random_uuid();
  line_a uuid := gen_random_uuid();
  line_b uuid := gen_random_uuid();
  centre uuid := gen_random_uuid();
  cat uuid;
  te_tech uuid := gen_random_uuid();
  te_other uuid := gen_random_uuid();
  te_b uuid := gen_random_uuid();
  exp_a uuid := gen_random_uuid();
  exp_b uuid := gen_random_uuid();
  m_tech uuid := gen_random_uuid();
  m_office uuid := gen_random_uuid();
  m_legacy uuid := gen_random_uuid();
  m_nojob uuid := gen_random_uuid();
  got uuid;
  n int;
  v text;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into tech from profiles where role = 'technician' and coalesce(is_active, true) and not coalesce(limited_access, false) limit 1;
    select id into admin_id from profiles where role = 'admin' and coalesce(is_active, true) limit 1;
    select id into office from profiles where role = 'office' and coalesce(is_active, true) limit 1;
    has_office := office is not null;
    office := coalesce(office, admin_id);
    if tech is null or admin_id is null then
      raise exception 'fixture missing: need an active technician and an active admin';
    end if;
    select id into cat from mistake_categories where is_active order by sort_order limit 1;
    if cat is null then raise exception 'fixture missing: no active mistake category'; end if;

    -- Fixtures as the session owner. The technician is on job A, not job B.
    perform set_config('request.jwt.claims', '', true);
    insert into customers (id, name) values (cust, '0119 Customer');
    insert into jobs (id, customer_id, assigned_to, title) values (job_a, cust, tech, '0119 job A');
    insert into jobs (id, customer_id, title) values (job_b, cust, '0119 job B');
    insert into cost_centres (id, name) values (centre, '0119 Centre ' || left(centre::text, 8));
    insert into purchase_orders (id, job_id, po_number, total_value) values (po_a, job_a, '0119-A', 10000);
    insert into purchase_orders (id, job_id, po_number, total_value) values (po_b, job_b, '0119-B', 5000);
    insert into po_cost_centers (id, po_id, name, allocated_amount, cost_centre_id) values (line_a, po_a, 'Drainage', 10000, centre);
    insert into po_cost_centers (id, po_id, name, allocated_amount) values (line_b, po_b, 'Drainage', 5000);
    insert into time_entries (id, job_id, staff_id, clock_in, clock_out, entry_type, hours)
      values (te_tech, job_a, tech, now() - interval '3 hours', now() - interval '1 hour', 'work', 2);
    insert into time_entries (id, job_id, staff_id, clock_in, clock_out, entry_type, hours)
      values (te_other, job_a, admin_id, now() - interval '3 hours', now() - interval '1 hour', 'work', 2);
    insert into time_entries (id, job_id, staff_id, clock_in, clock_out, entry_type, hours)
      values (te_b, job_b, tech, now() - interval '30 hours', now() - interval '28 hours', 'work', 2);
    insert into job_expenses (id, job_id, supplier_name, category, amount, gst_amount) values (exp_a, job_a, '0119 Supplier', 'materials', 300, 30);
    insert into job_expenses (id, job_id, supplier_name, category, amount, gst_amount) values (exp_b, job_b, '0119 Supplier', 'materials', 300, 30);

    -- ---------------------------------------------------------------- technician
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);

    select count(*) into n from mistake_categories where is_active;
    res := res || format('technician reads the categories|true|%s', (n >= 1)::text);

    begin
      insert into mistake_categories (name) values ('0119 tech category');
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician adds a category|BLOCKED|%s', outcome);

    begin
      insert into job_mistakes (job_id, description, category_id) values (job_a, '0119 direct', cat);
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician writes job_mistakes directly|BLOCKED|%s', outcome);

    begin
      got := raise_job_mistake(m_tech, job_a, line_a, cat, 'install', 'Pit set at the wrong level', null, array[te_tech]);
      outcome := case when got = m_tech then 'ALLOWED' else 'WRONG ID' end;
    exception when others then outcome := 'BLOCKED: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician raises a mistake on their job|ALLOWED|%s', outcome);

    begin
      got := raise_job_mistake(m_tech, job_a, line_a, cat, 'install', 'Pit set at the wrong level', null, array[te_tech]);
      outcome := case when got = m_tech then 'SAME' else 'OTHER' end;
    exception when others then outcome := 'ERROR: ' || sqlstate;
    end;
    res := res || format('a retry answers with the same mistake|SAME|%s', outcome);

    begin
      perform raise_job_mistake(gen_random_uuid(), job_b, null, cat, null, 'Not my job', null, null);
      outcome := 'ALLOWED';
    exception when sqlstate 'MJ123' then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician raises on a job they are not on|BLOCKED|%s', outcome);

    begin
      perform raise_job_mistake(gen_random_uuid(), job_a, line_b, cat, null, 'Wrong line', null, null);
      outcome := 'ALLOWED';
    exception when sqlstate 'MJ129' then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('raise with another job''s cost centre|BLOCKED|%s', outcome);

    begin
      perform raise_job_mistake(gen_random_uuid(), job_a, null, cat, null, 'Someone else''s time', null, array[te_other]);
      outcome := 'ALLOWED';
    exception when sqlstate 'MJ130' then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician marks someone else''s time as rework|BLOCKED|%s', outcome);

    begin
      perform raise_job_mistake(gen_random_uuid(), job_a, null, cat, null, 'Time on another job', null, array[te_b]);
      outcome := 'ALLOWED';
    exception when sqlstate 'MJ130' then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('technician marks their time on another job|BLOCKED|%s', outcome);

    begin
      perform raise_job_mistake(gen_random_uuid(), job_a, null, cat, 'bribery', 'Bad cause', null, null);
      outcome := 'ALLOWED';
    exception when sqlstate 'MJ126' then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('cause outside the fixed list|BLOCKED|%s', outcome);

    begin
      perform raise_job_mistake(gen_random_uuid(), job_a, null, cat, null, 'Tomorrow', (now() at time zone 'Australia/Melbourne')::date + 2, null);
      outcome := 'ALLOWED';
    exception when sqlstate 'MJ128' then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('a date in the future|BLOCKED|%s', outcome);

    select count(*) into n from job_mistakes;
    res := res || format('technician reads job_mistakes (rows)|0|%s', n);
    select count(*) into n from mistake_cost_lines;
    res := res || format('technician reads mistake_cost_lines (rows)|0|%s', n);
    select count(*) into n from mistake_photos;
    res := res || format('technician reads mistake_photos (rows)|0|%s', n);
    select count(*) into n from mistake_responsibility;
    res := res || format('technician reads mistake_responsibility (rows)|0|%s', n);

    select count(*) into n from my_job_mistakes(job_a);
    res := res || format('my_job_mistakes lists what they raised|1|%s', n);
    select status || '/' || coalesce(stage_name, '-') || '/' || cardinality(rework_entry_ids)::text into v from my_job_mistakes(job_a);
    res := res || format('it is open, on its stage, with their rework time|open/Drainage/1|%s', coalesce(v, 'null'));

    begin
      got := add_job_mistake_photo(m_tech, job_a::text || '/mistakes/' || m_tech::text || '/1-photo.jpg');
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('the raiser adds a photo at the mistake''s path|ALLOWED|%s', outcome);

    begin
      perform add_job_mistake_photo(m_tech, job_b::text || '/mistakes/' || m_tech::text || '/x.jpg');
      outcome := 'ALLOWED';
    exception when sqlstate 'MJ133' then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('a photo path outside the mistake|BLOCKED|%s', outcome);

    select photo_count::text into v from my_job_mistakes(job_a);
    res := res || format('the photo is counted|1|%s', coalesce(v, 'null'));

    -- ---------------------------------------------------------------- office
    perform set_config('request.jwt.claims', json_build_object('sub', office::text, 'role', 'authenticated')::text, true);

    select count(*) into n from my_job_mistakes(job_a);
    res := res || format('my_job_mistakes doesn''t list another person''s mistakes|0|%s', n);

    select (raised_by = tech and status = 'open' and cost_centre_id = centre)::text into v from job_mistakes where id = m_tech;
    res := res || format('office reads it: raised by the tech, open, company centre derived|true|%s', coalesce(v, 'null'));
    select count(*) into n from mistake_cost_lines where mistake_id = m_tech and source = 'time_entry' and source_id = te_tech;
    res := res || format('the rework time is a linked labour line|1|%s', n);

    begin
      insert into mistake_cost_lines (mistake_id, kind, source, amount_ex_gst, note) values (m_tech, 'material', 'manual', 85.50, 'Second pit riser');
      insert into mistake_cost_lines (mistake_id, kind, source, source_id) values (m_tech, 'material', 'job_expense', exp_a);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('office adds a manual line and links an expense|ALLOWED|%s', outcome);

    begin
      insert into mistake_cost_lines (mistake_id, kind, source, source_id) values (m_tech, 'material', 'job_expense', exp_b);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('linking another job''s expense|BLOCKED|%s', outcome);

    insert into job_mistakes (id, job_id, description, category_id) values (m_office, job_a, '0119 office mistake', cat);
    begin
      insert into mistake_cost_lines (mistake_id, kind, source, source_id) values (m_office, 'material', 'job_expense', exp_a);
      outcome := 'ALLOWED';
    exception when unique_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('the same expense linked to a second mistake|BLOCKED|%s', outcome);

    begin
      insert into mistake_cost_lines (mistake_id, kind, source, source_id, amount_ex_gst) values (m_tech, 'labour', 'time_entry', te_other, 99);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('a linked line carrying its own amount|BLOCKED|%s', outcome);

    begin
      update job_mistakes set recovery_source = 'supplier_credit', recovery_claimed_ex_gst = 85.50, recovered_ex_gst = 40,
             supplier_id = null, status = 'closed' where id = m_tech;
      get diagnostics n = row_count;
      outcome := case when n = 1 then 'ALLOWED' else 'NO ROWS' end;
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('office sets recovery and closes it|ALLOWED|%s', outcome);
    select (closed_at is not null and raised_by = tech)::text into v from job_mistakes where id = m_tech;
    res := res || format('closing stamps closed_at; raised_by unchanged|true|%s', coalesce(v, 'null'));

    -- An overhead mistake with no job.
    begin
      insert into job_mistakes (id, job_id, cost_centre_id, description, category_id) values (m_nojob, null, centre, 'Truck sent empty', cat);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('office logs a mistake with no job, on a company cost centre|ALLOWED|%s', outcome);
    begin
      insert into job_mistakes (job_id, description) values (null, 'No job, no centre');
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('no job and no company cost centre|BLOCKED|%s', outcome);
    begin
      insert into mistake_cost_lines (mistake_id, kind, source, source_id) values (m_nojob, 'labour', 'time_entry', te_other);
      outcome := 'ALLOWED';
    exception when check_violation then outcome := 'BLOCKED';
    when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
    end;
    res := res || format('a job-less mistake linking a job''s cost|BLOCKED|%s', outcome);

    -- A client built before 0119 still logs with an amount and whose mistake.
    begin
      insert into job_mistakes (id, job_id, cost_center_id, amount_ex_gst, description, staff_id)
        values (m_legacy, job_a, line_a, 250, '0119 old-style mistake', tech);
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('an old-style insert with an amount|ALLOWED|%s', outcome);
    select coalesce(sum(amount_ex_gst), 0)::text into v from mistake_cost_lines where mistake_id = m_legacy and legacy;
    res := res || format('it becomes a legacy manual line|250.00|%s', v);
    select coalesce(staff_id::text, 'null') into v from job_mistakes where id = m_legacy;
    res := res || format('whose mistake never stays on job_mistakes|null|%s', v);
    update job_mistakes set amount_ex_gst = 275 where id = m_legacy;
    select coalesce(sum(amount_ex_gst), 0)::text into v from mistake_cost_lines where mistake_id = m_legacy and legacy;
    res := res || format('an old-style edit moves the legacy line|275.00|%s', v);
    update mistake_cost_lines set amount_ex_gst = 300 where mistake_id = m_legacy and legacy;
    select amount_ex_gst::text into v from job_mistakes where id = m_legacy;
    res := res || format('editing the legacy line moves the old amount|300.00|%s', coalesce(v, 'null'));

    if has_office then
      select count(*) into n from mistake_responsibility;
      res := res || format('office reads whose mistake (rows)|0|%s', n);
      begin
        insert into mistake_responsibility (mistake_id, staff_id) values (m_tech, tech);
        outcome := 'ALLOWED';
      exception when insufficient_privilege then outcome := 'BLOCKED';
      when others then outcome := 'OTHER ERROR: ' || sqlstate || ' ' || sqlerrm;
      end;
      res := res || format('office records whose mistake|BLOCKED|%s', outcome);
      perform set_config('role', 'postgres', true);
      select count(*) into n from mistake_responsibility where mistake_id = m_legacy;
      perform set_config('role', 'authenticated', true);
      res := res || format('an office user''s old-style "whose" is dropped|0|%s', n);
    end if;

    -- ---------------------------------------------------------------- admin
    perform set_config('request.jwt.claims', json_build_object('sub', admin_id::text, 'role', 'authenticated')::text, true);
    begin
      insert into mistake_responsibility (mistake_id, staff_id, note) values (m_tech, tech, 'Level not checked');
      outcome := 'ALLOWED';
    exception when others then outcome := 'BLOCKED: ' || sqlerrm;
    end;
    res := res || format('admin records whose mistake|ALLOWED|%s', outcome);
    update job_mistakes set staff_id = tech where id = m_office;
    select count(*) into n from mistake_responsibility where mistake_id = m_office;
    res := res || format('an admin''s old-style "whose" moves to its table|1|%s', n);

    -- ---------------------------------------------------------------- deletes
    perform set_config('request.jwt.claims', '', true);
    perform set_config('role', 'postgres', true);
    delete from job_expenses where id = exp_a;
    select count(*) into n from mistake_cost_lines where source = 'job_expense' and source_id = exp_a;
    res := res || format('deleting the expense removes its link|0|%s', n);
    delete from mistake_cost_lines where mistake_id = m_legacy and legacy;
    select coalesce(amount_ex_gst::text, 'null') into v from job_mistakes where id = m_legacy;
    res := res || format('deleting the legacy line clears the old amount|null|%s', v);

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
    raise exception E'0119 gate FAILED — % of % scenario(s):%', n_fail, array_length(res, 1), failures;
  end if;
  raise notice '0119 gate: % scenarios passed', array_length(res, 1);
end;
$$;

select '0119 PASSED' as result;
