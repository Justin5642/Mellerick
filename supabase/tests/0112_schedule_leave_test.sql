-- ============================================================================
-- GATE TEST for 0112 — leave on the schedule.
--
--   Paste the whole file into the Supabase SQL editor AFTER 0112.
--   Trust only a final "0112 PASSED" row; anything else is a failure.
--
-- ONE DO BLOCK, SELF-UNDOING (pattern: 0073_deactivation_test.sql). The
-- fixture (a leave row, setting changes, a limited flag) lives in an inner
-- block that ends by raising a private SQLSTATE, which rolls it back; the
-- results survive in local variables and are checked afterwards.
--
-- Needs an active technician and an active admin. An office user is optional
-- (production may have none): its checks are skipped with a notice.
-- ============================================================================

do $$
declare
  tech uuid;
  adm  uuid;
  off  uuid;
  lid  uuid;
  r record;
  failures text := '';
  ran boolean := false;
  -- what each caller received for the fixture row
  tech_type text := 'unset';  tech_id uuid;  tech_n int := -1;
  off_type text := 'unset';   off_id uuid;
  adm_type text := 'unset';   adm_id uuid;
  off_type_admin_only text := 'unset';
  tech_type_everyone text := 'unset';
  limited_n int := -1;
  tech_direct_n int := -1;
  tech_setting_changed boolean := false;
  one_sided_refused boolean := false;
  backwards_refused boolean := false;
  range_refused boolean := false;
  timed_start time;
begin
  select id into tech from profiles where role = 'technician' and coalesce(is_active, true) order by full_name limit 1;
  select id into adm  from profiles where role = 'admin' and coalesce(is_active, true) order by full_name limit 1;
  select id into off  from profiles where role = 'office' and coalesce(is_active, true) order by full_name limit 1;
  if tech is null or adm is null then
    raise exception '0112 gate FAILED: needs an active technician and an active admin profile';
  end if;

  -- Structure (no fixture needed) ------------------------------------------------
  if has_function_privilege('anon', 'public.schedule_leave(date, date)', 'execute') then
    failures := failures || 'anon can execute schedule_leave; ';
  end if;
  if not has_function_privilege('authenticated', 'public.schedule_leave(date, date)', 'execute') then
    failures := failures || 'authenticated cannot execute schedule_leave; ';
  end if;
  if not has_table_privilege('authenticated', 'public.schedule_settings', 'select') then
    failures := failures || 'authenticated cannot read schedule_settings; ';
  end if;
  if exists (
    select 1 from pg_proc p
    where p.oid = 'public.schedule_leave(date, date)'::regprocedure
      and (array_to_string(p.proargnames, ',') ilike '%notes%')
  ) then
    failures := failures || 'schedule_leave returns notes; ';
  end if;
  if (select leave_type_visible_to from schedule_settings where id) is distinct from 'office_admin' then
    raise notice '0112: leave_type_visible_to is not the default office_admin (someone changed it) — checks set it explicitly';
  end if;

  begin
    -- Fixture: a sick day for the technician, far from real data.
    insert into staff_leave (staff_id, leave_type, start_date, end_date, hours, notes, start_time, end_time)
    values (tech, 'sick', date '2099-03-03', date '2099-03-03', 3.5, '0112 gate private note', '12:00', '15:30')
    returning id into lid;
    select start_time into timed_start from staff_leave where id = lid;

    update schedule_settings set leave_type_visible_to = 'office_admin' where id;

    -- Technician ------------------------------------------------------------------
    perform set_config('request.jwt.claims', json_build_object('sub', tech, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select count(*) into tech_n from schedule_leave(date '2099-03-01', date '2099-03-31') s where s.staff_id = tech;
    select s.leave_type, s.id into tech_type, tech_id from schedule_leave(date '2099-03-01', date '2099-03-31') s where s.staff_id = tech;
    select count(*) into tech_direct_n from staff_leave where id = lid;
    update schedule_settings set leave_type_visible_to = 'everyone' where id;
    begin
      perform * from schedule_leave(date '2099-01-01', date '2100-12-31');
    exception when sqlstate '22023' then range_refused := true;
    end;
    execute 'reset role';
    tech_setting_changed := (select leave_type_visible_to from schedule_settings where id) <> 'office_admin';

    -- Office ------------------------------------------------------------------------
    if off is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', off, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      select s.leave_type, s.id into off_type, off_id from schedule_leave(date '2099-03-01', date '2099-03-31') s where s.staff_id = tech;
      execute 'reset role';
    end if;

    -- Admin -------------------------------------------------------------------------
    perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select s.leave_type, s.id into adm_type, adm_id from schedule_leave(date '2099-03-01', date '2099-03-31') s where s.staff_id = tech;
    execute 'reset role';

    -- Setting: admin only → office loses the type ----------------------------------
    update schedule_settings set leave_type_visible_to = 'admin' where id;
    if off is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', off, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      select s.leave_type into off_type_admin_only from schedule_leave(date '2099-03-01', date '2099-03-31') s where s.staff_id = tech;
      execute 'reset role';
    end if;

    -- Setting: everyone → technician sees the type ---------------------------------
    update schedule_settings set leave_type_visible_to = 'everyone' where id;
    perform set_config('request.jwt.claims', json_build_object('sub', tech, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select s.leave_type into tech_type_everyone from schedule_leave(date '2099-03-01', date '2099-03-31') s where s.staff_id = tech;
    execute 'reset role';

    -- Limited-access account (0110) receives nothing --------------------------------
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    update profiles set limited_access = true where id = tech;
    perform set_config('request.jwt.claims', json_build_object('sub', tech, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select count(*) into limited_n from schedule_leave(date '2099-03-01', date '2099-03-31');
    execute 'reset role';

    -- Part-day constraint -----------------------------------------------------------
    begin
      insert into staff_leave (staff_id, leave_type, start_date, end_date, hours, start_time)
      values (tech, 'sick', date '2099-03-04', date '2099-03-04', 2, '09:00');
    exception when check_violation then one_sided_refused := true;
    end;
    begin
      insert into staff_leave (staff_id, leave_type, start_date, end_date, hours, start_time, end_time)
      values (tech, 'sick', date '2099-03-04', date '2099-03-04', 2, '15:00', '09:00');
    exception when check_violation then backwards_refused := true;
    end;

    ran := true;
    raise exception using errcode = 'P0112';
  exception
    when sqlstate 'P0112' then null;  -- rolled back on purpose
    when others then
      execute 'reset role';
      failures := failures || 'scenario run failed: ' || sqlerrm || '; ';
  end;

  if ran then
    if tech_n <> 1 then failures := failures || format('technician received %s rows for their leave (want 1); ', tech_n); end if;
    if tech_type is not null then failures := failures || format('technician received leave_type %L (want NULL); ', tech_type); end if;
    if tech_id is not null then failures := failures || 'technician received the leave id; '; end if;
    if tech_direct_n <> 0 then failures := failures || 'technician can read staff_leave directly; '; end if;
    if tech_setting_changed then failures := failures || 'technician changed schedule_settings; '; end if;
    if not range_refused then failures := failures || 'a 2-year range was not refused; '; end if;
    if off is not null then
      if off_type is distinct from 'sick' then failures := failures || format('office received leave_type %L (want sick); ', off_type); end if;
      if off_id is not null then failures := failures || 'office received the leave id; '; end if;
      if off_type_admin_only is not null then failures := failures || format('office received %L with the admin-only setting; ', off_type_admin_only); end if;
    else
      raise notice '0112: no office profile — office checks skipped';
    end if;
    if adm_type is distinct from 'sick' then failures := failures || format('admin received leave_type %L (want sick); ', adm_type); end if;
    if adm_id is null then failures := failures || 'admin did not receive the leave id; '; end if;
    if tech_type_everyone is distinct from 'sick' then failures := failures || format('technician received %L with the everyone setting; ', tech_type_everyone); end if;
    if limited_n <> 0 then failures := failures || format('limited account received %s rows; ', limited_n); end if;
    if not one_sided_refused then failures := failures || 'a start_time without end_time was accepted; '; end if;
    if not backwards_refused then failures := failures || 'an end_time before start_time was accepted; '; end if;
    if timed_start is distinct from time '12:00' then failures := failures || 'start_time did not save; '; end if;
  end if;

  if failures <> '' then raise exception '0112 gate FAILED: %', failures; end if;
end $$;

select '0112 PASSED' as result;
