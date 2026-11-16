-- ============================================================================
-- GATE TEST for 0109 — job_bookings.note.
--
--   paste into the Supabase SQL editor after 0109 (or psql -f).
--
-- ONE DO BLOCK, SELF-UNDOING (see the 0073 test's header): the writes happen
-- in an inner block that ends by raising a private SQLSTATE, which rolls them
-- back; what was learnt is kept in local variables and judged afterwards.
-- Ends with a SELECT so a rolled-back run shows a red error, never a quiet
-- notice.
--
-- Checks: the column and its length check exist; authenticated may select,
-- insert and update it; as an office/admin user a note can be written and
-- read back on a booking, a 2001-character note is refused, and a note-only
-- edit leaves the job's derived schedule alone. If the database has no
-- booking or no active office/admin profile, the impersonation half says so
-- and the shape checks stand.
-- ============================================================================

do $$
declare
  failures text := '';
  off uuid;
  bk record;
  job_before record;
  job_after record;
  read_back text;
  too_long_refused boolean := false;
  ran boolean := false;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'job_bookings' and column_name = 'note') then
    failures := failures || 'job_bookings.note missing; ';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.job_bookings'::regclass and conname = 'job_bookings_note_length') then
    failures := failures || 'length check missing; ';
  end if;
  if not has_column_privilege('authenticated', 'public.job_bookings', 'note', 'select') then
    failures := failures || 'authenticated cannot select note; ';
  end if;
  if not has_column_privilege('authenticated', 'public.job_bookings', 'note', 'insert') then
    failures := failures || 'authenticated cannot insert note; ';
  end if;
  if not has_column_privilege('authenticated', 'public.job_bookings', 'note', 'update') then
    failures := failures || 'authenticated cannot update note; ';
  end if;

  select id into off from profiles
   where role in ('office', 'admin') and is_active is not false
   order by (role = 'office') desc limit 1;
  select b.* into bk from job_bookings b order by b.starts_at desc limit 1;

  if off is not null and bk.id is not null then
    begin
      select scheduled_start, scheduled_end, schedule_daily, schedule_all_day
        into job_before from jobs where id = bk.job_id;

      perform set_config('request.jwt.claims', json_build_object('sub', off, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';

      update job_bookings set note = '0109 gate test note' where id = bk.id;
      select note into read_back from job_bookings where id = bk.id;

      begin
        update job_bookings set note = repeat('x', 2001) where id = bk.id;
      exception when check_violation then
        too_long_refused := true;
      end;

      execute 'reset role';
      select scheduled_start, scheduled_end, schedule_daily, schedule_all_day
        into job_after from jobs where id = bk.job_id;
      ran := true;
      raise exception using errcode = 'P0109';
    exception
      when sqlstate 'P0109' then null;  -- rolled back on purpose
      when others then
        execute 'reset role';
        failures := failures || 'impersonation failed: ' || sqlerrm || '; ';
    end;

    if ran then
      if read_back is distinct from '0109 gate test note' then
        failures := failures || format('note read back as %L; ', read_back);
      end if;
      if not too_long_refused then
        failures := failures || 'a 2001-character note was accepted; ';
      end if;
      if job_after is distinct from job_before then
        failures := failures || 'a note-only edit changed the job''s schedule; ';
      end if;
    end if;
  else
    raise notice '0109: no booking or no office/admin profile — write checks skipped';
  end if;

  if failures <> '' then raise exception '0109 gate FAILED: %', failures; end if;
end $$;

select '0109 PASSED' as result;
