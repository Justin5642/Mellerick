-- ============================================================================
-- GATE TEST for 0113 — Komtrax machine data.
--
--   Paste the whole file into the Supabase SQL editor AFTER 0113.
--   Trust only a final "0113 PASSED" row; anything else is a failure.
--
-- ONE DO BLOCK, SELF-UNDOING (pattern: 0073_deactivation_test.sql). The
-- fixture (a machine, a reading, a fault) lives in an inner block that ends
-- by raising a private SQLSTATE, which rolls it back; the results survive in
-- local variables and are checked afterwards.
--
-- Needs an active technician and an active admin. An office user is optional.
-- ============================================================================

do $$
declare
  tech uuid;
  adm  uuid;
  off  uuid;
  mid  uuid;
  eq   uuid;
  failures text := '';
  ran boolean := false;
  tech_machines int := -1;
  tech_readings int := -1;
  tech_faults int := -1;
  tech_state int := -1;
  tech_link_n int := -1;
  adm_machines int := -1;
  adm_faults int := -1;
  off_machines int := -1;
  adm_linked uuid;
  adm_hours_refused boolean := false;
  adm_insert_refused boolean := false;
  adm_error_refused boolean := false;
  dup_link_refused boolean := false;
  dup_reading_refused boolean := false;
begin
  select id into tech from profiles where role = 'technician' and coalesce(is_active, true) order by full_name limit 1;
  select id into adm  from profiles where role = 'admin' and coalesce(is_active, true) order by full_name limit 1;
  select id into off  from profiles where role = 'office' and coalesce(is_active, true) order by full_name limit 1;
  if tech is null or adm is null then
    raise exception '0113 gate FAILED: needs an active technician and an active admin profile';
  end if;

  -- Structure ---------------------------------------------------------------------
  if has_table_privilege('anon', 'public.komtrax_machines', 'select') then failures := failures || 'anon can read komtrax_machines; '; end if;
  if not has_table_privilege('authenticated', 'public.komtrax_faults', 'select') then failures := failures || 'authenticated cannot read komtrax_faults (0088 trap); '; end if;
  if has_column_privilege('authenticated', 'public.komtrax_sync_state', 'last_error', 'select') then failures := failures || 'last_error is readable by signed-in users; '; end if;
  if exists (select 1 from pg_publication_tables where tablename like 'komtrax%') then failures := failures || 'a komtrax table is published to PowerSync; '; end if;
  if (select count(*) from komtrax_sync_state) <> 1 then failures := failures || 'komtrax_sync_state does not have exactly one row; '; end if;

  begin
    select id into eq from equipment where is_active order by name limit 1;

    insert into komtrax_machines (make_code, model, serial, hours, hours_at)
    values ('0113GATE', 'PC0113', 'SN0113', 1234.5, now())
    returning id into mid;
    insert into komtrax_hour_readings (machine_id, read_at, hours) values (mid, timestamptz '2099-01-01 00:00+00', 1234.5);
    insert into komtrax_faults (machine_id, code, severity, description, occurred_at)
    values (mid, 'E0113', 'High', '0113 gate fault', now());

    begin
      insert into komtrax_hour_readings (machine_id, read_at, hours) values (mid, timestamptz '2099-01-01 00:00+00', 1234.5);
    exception when unique_violation then dup_reading_refused := true;
    end;

    -- Technician: sees nothing, changes nothing ------------------------------------
    perform set_config('request.jwt.claims', json_build_object('sub', tech, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select count(*) into tech_machines from komtrax_machines where id = mid;
    select count(*) into tech_readings from komtrax_hour_readings where machine_id = mid;
    select count(*) into tech_faults from komtrax_faults where machine_id = mid;
    select count(*) into tech_state from komtrax_sync_state;
    update komtrax_machines set matched_by = 'office' where id = mid;
    get diagnostics tech_link_n = row_count;
    execute 'reset role';

    -- Office (optional) ----------------------------------------------------------------
    if off is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', off, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      select count(*) into off_machines from komtrax_machines where id = mid;
      execute 'reset role';
    end if;

    -- Admin: reads, links, but cannot write data ----------------------------------------
    perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select count(*) into adm_machines from komtrax_machines where id = mid;
    select count(*) into adm_faults from komtrax_faults where machine_id = mid;
    if eq is not null then
      update komtrax_machines set equipment_id = eq, matched_by = 'office' where id = mid;
      select equipment_id into adm_linked from komtrax_machines where id = mid;
    end if;
    begin
      update komtrax_machines set hours = 1 where id = mid;
    exception when insufficient_privilege then adm_hours_refused := true;
    end;
    begin
      insert into komtrax_faults (machine_id, code, occurred_at) values (mid, 'X', now());
    exception when insufficient_privilege then adm_insert_refused := true;
    end;
    begin
      perform last_error from komtrax_sync_state;
    exception when insufficient_privilege then adm_error_refused := true;
    end;
    execute 'reset role';

    -- One Komtrax machine per fleet item -------------------------------------------------
    if eq is not null then
      begin
        insert into komtrax_machines (make_code, model, serial, equipment_id) values ('0113GATE', 'PC0113', 'SN0113-B', eq);
      exception when unique_violation then dup_link_refused := true;
      end;
    end if;

    ran := true;
    raise exception using errcode = 'ZK113', message = '0113 undo';
  exception
    when sqlstate 'ZK113' then null;
    when others then
      failures := failures || 'scenario run failed: ' || sqlerrm || '; ';
  end;

  if ran then
    if tech_machines <> 0 then failures := failures || 'technician can read komtrax_machines; '; end if;
    if tech_readings <> 0 then failures := failures || 'technician can read komtrax_hour_readings; '; end if;
    if tech_faults <> 0 then failures := failures || 'technician can read komtrax_faults; '; end if;
    if tech_state <> 0 then failures := failures || 'technician can read komtrax_sync_state; '; end if;
    if tech_link_n <> 0 then failures := failures || 'technician changed a machine link; '; end if;
    if adm_machines <> 1 then failures := failures || 'admin cannot read komtrax_machines; '; end if;
    if adm_faults <> 1 then failures := failures || 'admin cannot read komtrax_faults; '; end if;
    if off is not null and off_machines <> 1 then failures := failures || 'office cannot read komtrax_machines; '; end if;
    if off is null then raise notice '0113: no office profile — office checks skipped'; end if;
    if eq is not null and adm_linked is distinct from eq then failures := failures || 'admin could not link a machine; '; end if;
    if eq is not null and not dup_link_refused then failures := failures || 'two Komtrax machines linked to one fleet item; '; end if;
    if eq is null then raise notice '0113: no active equipment — link checks skipped'; end if;
    if not adm_hours_refused then failures := failures || 'admin could change Komtrax hours; '; end if;
    if not adm_insert_refused then failures := failures || 'admin could insert a fault; '; end if;
    if not adm_error_refused then failures := failures || 'admin could read last_error; '; end if;
    if not dup_reading_refused then failures := failures || 'a duplicate hour reading was accepted; '; end if;
  end if;

  if failures <> '' then raise exception '0113 gate FAILED: %', failures; end if;
end $$;

select '0113 PASSED' as result;
