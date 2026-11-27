-- ============================================================================
-- "Didn't make it" on a booking — the technician says why they didn't get to it.
--
-- STATUS: ✅ APPLIED 2026-11-27 (gate test passed). Was: paste this file into the Supabase SQL editor,
-- then supabase/tests/0121_booking_missed_test.sql, and trust only its final
-- "0121 PASSED" row. Then change this line to applied, add the ledger row
-- ('0121','booking_missed'), regenerate types, and THEN redeploy the PowerSync
-- streams (tech_job_bookings lists missed_at / missed_reason / missed_note —
-- not before this is applied).
--
-- WHY (Justin, 27 Nov 2026): technicians sometimes don't make it to a job
-- they're booked on, and the office can't tell a no-show from a forgotten
-- close-out. His decisions: the technician flags THEIR OWN booking with a
-- reason (Ran out of time · Previous job ran over · Site not ready / no access
-- · Weather · Sick / unavailable · Other + note); the booking STAYS WHERE IT
-- IS, flagged — nothing is moved or deleted; the office reschedules by
-- dragging it as usual, and moving it clears the flag. The office sees a red
-- "Didn't make it — <reason>" tag on both schedules.
--
-- WHAT THIS DOES
--   1. job_bookings.missed_at / missed_by / missed_reason / missed_note.
--      All null = not flagged. Checks: reason in the six keys; the reason, the
--      time and the person set together or all null (missed_by may go null
--      later when the profile is deleted — on delete set null); 'other' needs
--      a non-empty note; note ≤ 500.
--   2. flag_booking_missed(booking, reason, note) / clear_booking_missed(booking)
--      — SECURITY DEFINER, executable by `authenticated` only. job_bookings
--      stays office-written by RLS (0079); these are the narrow door for a
--      technician. The caller must be active, not a limited-access account
--      (0110), and either the booking's technician or office/admin. The job
--      must be open (0096's sentence, MJ001); the booking's first booked day
--      must be today or earlier (Melbourne) — a future booking can't be
--      missed yet. Idempotent: the same flag again changes nothing.
--   3. Trigger job_bookings_clear_missed (BEFORE UPDATE OF starts_at, ends_at,
--      staff_id): a booking moved to other times or another technician — the
--      office rescheduled it — loses the flag.
--   4. 0080's job_bookings_touch and job_bookings_derive_update are re-hung
--      with WHEN clauses that also ignore the four missed columns (functions
--      unchanged). So a flag write:
--        * doesn't bump updated_at — the calendar poll's "newer side wins"
--          (lib/calendar-booking-sync.ts) never sees it as the app's edit;
--        * doesn't re-derive the job (no jobs UPDATE, scheduled_start/end and
--          jobs.updated_at untouched);
--        * is still real activity for the sync windows (0068/0080's
--          sync_office_child_after compares everything but sync_office) —
--          the booking and its job come back onto office devices.
--      0096's job_bookings_refuse_closed_job fires only on UPDATE OF the
--      window / staff columns, which the functions never set.
--
-- ERRCODES (mapped to fixed sentences by the route,
-- app/api/jobs/[id]/bookings/[bookingId]/missed): MJ141 not signed in /
-- missing booking, MJ142 not allowed (inactive, limited, not yours), MJ143
-- booking not found, MJ001 closed job (0096's words), MJ144 future booking,
-- MJ145 unassigned booking, MJ146 bad reason, MJ147 Other without a note,
-- MJ148 note too long. (MJ120–MJ134 are 0119's.)
--
-- NO MONEY: reasons, a note, a time and a person. job_bookings still has no
-- money column (asserted below).
--
-- GRANTS: job_bookings has table-level privileges only (0109's header — 0079
-- grants nothing column by column), so the new columns are covered by the
-- existing grants; RLS still lets only office/admin UPDATE (asserted).
--
-- Idempotent: re-runnable. No temp tables (pasted into the SQL editor).
-- ============================================================================

do $$
begin
  if to_regclass('public.job_bookings') is null then
    raise exception '0121 needs 0079 (job_bookings) applied first';
  end if;
  if to_regprocedure('public.job_status_is_closed(text)') is null then
    raise exception '0121 needs 0096 (job_status_is_closed) applied first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles' and column_name = 'limited_access') then
    raise exception '0121 needs 0110 (profiles.limited_access) applied first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'job_bookings' and column_name = 'sync_office') then
    raise exception '0121 needs 0080 (job_bookings.sync_office) applied first';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The columns and their checks
-- ---------------------------------------------------------------------------
alter table job_bookings add column if not exists missed_at timestamptz;
alter table job_bookings add column if not exists missed_by uuid references profiles(id) on delete set null;
alter table job_bookings add column if not exists missed_reason text;
alter table job_bookings add column if not exists missed_note text;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.job_bookings'::regclass and conname = 'job_bookings_missed_reason') then
    alter table job_bookings add constraint job_bookings_missed_reason check (
      missed_reason is null
      or missed_reason in ('out_of_time', 'previous_job_ran_over', 'site_not_ready', 'weather', 'unavailable', 'other'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.job_bookings'::regclass and conname = 'job_bookings_missed_note_length') then
    alter table job_bookings add constraint job_bookings_missed_note_length check (
      missed_note is null or char_length(missed_note) <= 500);
  end if;
  -- Set together or all null. missed_by may become null afterwards (its
  -- profile deleted), so it is required only while the flag is being set:
  -- reason and time go together; a note needs a reason.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.job_bookings'::regclass and conname = 'job_bookings_missed_together') then
    alter table job_bookings add constraint job_bookings_missed_together check (
      ((missed_reason is null) = (missed_at is null))
      and (missed_reason is not null or (missed_by is null and missed_note is null)));
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.job_bookings'::regclass and conname = 'job_bookings_missed_other_note') then
    alter table job_bookings add constraint job_bookings_missed_other_note check (
      missed_reason is distinct from 'other' or coalesce(btrim(missed_note), '') <> '');
  end if;
end;
$$;

comment on column job_bookings.missed_at is
  'When the technician (or office) flagged this booking "Didn''t make it" (0121). Null = not flagged. '
  'Cleared when the booking is moved (job_bookings_clear_missed).';
comment on column job_bookings.missed_by is 'Who flagged it "Didn''t make it" (0121).';
comment on column job_bookings.missed_reason is
  '0121 reason key: out_of_time, previous_job_ran_over, site_not_ready, weather, unavailable, other.';
comment on column job_bookings.missed_note is 'Optional note (required for other), ≤ 500 characters (0121).';

-- ---------------------------------------------------------------------------
-- 2. Moving the booking clears the flag
-- ---------------------------------------------------------------------------
create or replace function job_bookings_clear_missed()
returns trigger
language plpgsql
as $$
begin
  if new.missed_reason is not null
     and (new.starts_at is distinct from old.starts_at
          or new.ends_at is distinct from old.ends_at
          or new.staff_id is distinct from old.staff_id) then
    new.missed_at := null;
    new.missed_by := null;
    new.missed_reason := null;
    new.missed_note := null;
  end if;
  return new;
end;
$$;

drop trigger if exists job_bookings_clear_missed on job_bookings;
create trigger job_bookings_clear_missed
  before update of starts_at, ends_at, staff_id on job_bookings
  for each row execute function job_bookings_clear_missed();

revoke execute on function job_bookings_clear_missed() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. A flag write is not a schedule edit (0080's WHEN clauses, widened)
-- ---------------------------------------------------------------------------
drop trigger if exists job_bookings_touch on job_bookings;
create trigger job_bookings_touch before update on job_bookings
  for each row
  when ((to_jsonb(new) - 'sync_office' - 'missed_at' - 'missed_by' - 'missed_reason' - 'missed_note')
        is distinct from
        (to_jsonb(old) - 'sync_office' - 'missed_at' - 'missed_by' - 'missed_reason' - 'missed_note'))
  execute function job_bookings_touch();

drop trigger if exists job_bookings_derive_update on job_bookings;
create trigger job_bookings_derive_update after update on job_bookings
  for each row
  when ((to_jsonb(new) - 'sync_office' - 'updated_at' - 'missed_at' - 'missed_by' - 'missed_reason' - 'missed_note')
        is distinct from
        (to_jsonb(old) - 'sync_office' - 'updated_at' - 'missed_at' - 'missed_by' - 'missed_reason' - 'missed_note'))
  execute function job_bookings_after_change();

-- ---------------------------------------------------------------------------
-- 4. The doors
-- ---------------------------------------------------------------------------

-- Shared checks: who, which booking, is it flaggable. Returns the booking.
create or replace function booking_missed_target(p_booking uuid)
returns job_bookings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_active boolean;
  v_limited boolean;
  v_row job_bookings;
  v_status text;
  v_number int;
  v_first date;
begin
  if v_uid is null or p_booking is null then
    raise exception 'Missing details.' using errcode = 'MJ141';
  end if;

  select role, coalesce(is_active, true), coalesce(limited_access, false)
    into v_role, v_active, v_limited
    from profiles where id = v_uid;
  if v_role is null or not v_active or v_limited then
    raise exception 'You can''t change this booking.' using errcode = 'MJ142';
  end if;

  select * into v_row from job_bookings where id = p_booking;
  if not found then
    raise exception 'Booking not found.' using errcode = 'MJ143';
  end if;
  if v_row.staff_id is null then
    raise exception 'That booking has no technician.' using errcode = 'MJ145';
  end if;
  if v_row.staff_id <> v_uid and v_role not in ('office', 'admin') then
    raise exception 'That booking isn''t yours.' using errcode = 'MJ142';
  end if;

  select status, job_number into v_status, v_number from jobs where id = v_row.job_id;
  if job_status_is_closed(v_status) then
    raise exception 'Job #% is %. A % job can''t be scheduled — reopen it first.', v_number, v_status, v_status
      using errcode = 'MJ001';
  end if;

  -- The first booked day is the start's Melbourne day (0071: a daily booking
  -- books its start date even on a weekend).
  v_first := (v_row.starts_at at time zone 'Australia/Melbourne')::date;
  if v_first > (now() at time zone 'Australia/Melbourne')::date then
    raise exception 'That booking hasn''t started yet.' using errcode = 'MJ144';
  end if;

  return v_row;
end;
$$;

create or replace function flag_booking_missed(p_booking uuid, p_reason text, p_note text)
returns job_bookings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row job_bookings;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_reason is null or p_reason not in ('out_of_time', 'previous_job_ran_over', 'site_not_ready', 'weather', 'unavailable', 'other') then
    raise exception 'Pick a reason.' using errcode = 'MJ146';
  end if;
  if p_reason = 'other' and v_note is null then
    raise exception 'Say what happened (Other needs a note).' using errcode = 'MJ147';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'Keep the note to 500 characters.' using errcode = 'MJ148';
  end if;

  v_row := booking_missed_target(p_booking);

  -- The same flag again: nothing to write (a retried request).
  if v_row.missed_reason is not distinct from p_reason and v_row.missed_note is not distinct from v_note then
    return v_row;
  end if;

  update job_bookings
     set missed_at = coalesce(case when missed_reason is not null then missed_at end, now()),
         missed_by = auth.uid(),
         missed_reason = p_reason,
         missed_note = v_note
   where id = p_booking
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function clear_booking_missed(p_booking uuid)
returns job_bookings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row job_bookings;
begin
  v_row := booking_missed_target(p_booking);
  if v_row.missed_reason is null then
    return v_row;
  end if;
  update job_bookings
     set missed_at = null, missed_by = null, missed_reason = null, missed_note = null
   where id = p_booking
  returning * into v_row;
  return v_row;
end;
$$;

comment on function flag_booking_missed(uuid, text, text) is
  'The booking''s technician (or office/admin) says they didn''t make it, with a reason (0121). '
  'The booking stays where it is; moving it clears the flag.';
comment on function clear_booking_missed(uuid) is 'Undo "Didn''t make it" on a booking (0121).';

revoke execute on function booking_missed_target(uuid) from public, anon, authenticated;
revoke execute on function flag_booking_missed(uuid, text, text) from public, anon;
revoke execute on function clear_booking_missed(uuid) from public, anon;
grant execute on function flag_booking_missed(uuid, text, text) to authenticated, service_role;
grant execute on function clear_booking_missed(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Assert the end state
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
  fn text;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'job_bookings'
     and column_name in ('missed_at', 'missed_by', 'missed_reason', 'missed_note');
  if n <> 4 then
    raise exception 'ASSERTION FAILED: job_bookings has % of the 4 missed columns', n;
  end if;

  select count(*) into n from pg_constraint
   where conrelid = 'public.job_bookings'::regclass
     and conname in ('job_bookings_missed_reason', 'job_bookings_missed_note_length',
                     'job_bookings_missed_together', 'job_bookings_missed_other_note');
  if n <> 4 then
    raise exception 'ASSERTION FAILED: % of the 4 missed checks exist', n;
  end if;

  select count(*) into n from pg_trigger
   where tgrelid = 'job_bookings'::regclass and not tgisinternal and tgenabled <> 'D'
     and tgname in ('job_bookings_clear_missed', 'job_bookings_touch', 'job_bookings_derive_update', 'job_bookings_derive');
  if n <> 4 then
    raise exception 'ASSERTION FAILED: job_bookings triggers missing or disabled (% of 4)', n;
  end if;
  if position('missed_reason' in (select pg_get_triggerdef(oid) from pg_trigger
                                   where tgrelid = 'job_bookings'::regclass and tgname = 'job_bookings_touch')) = 0 then
    raise exception 'ASSERTION FAILED: job_bookings_touch still counts a flag write as an edit';
  end if;

  foreach fn in array array['public.flag_booking_missed(uuid, text, text)', 'public.clear_booking_missed(uuid)'] loop
    if not (select prosecdef from pg_proc where oid = fn::regprocedure) then
      raise exception 'ASSERTION FAILED: % is not SECURITY DEFINER', fn;
    end if;
    if has_function_privilege('anon', fn, 'execute') then
      raise exception 'ASSERTION FAILED: anon can run %', fn;
    end if;
    if not has_function_privilege('authenticated', fn, 'execute') then
      raise exception 'ASSERTION FAILED: authenticated cannot run %', fn;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.booking_missed_target(uuid)', 'execute') then
    raise exception 'ASSERTION FAILED: authenticated can run booking_missed_target';
  end if;

  -- job_bookings is still written by office/admin only.
  select count(*) into n from pg_policy
   where polrelid = 'job_bookings'::regclass and polcmd in ('a', 'w', 'd', '*')
     and position('is_office_or_admin' in coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '')) = 0;
  if n > 0 then
    raise exception 'ASSERTION FAILED: a job_bookings write policy is not office/admin';
  end if;

  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'job_bookings'
                and column_name ~* '(amount|value|price|cost$|rate|total|gst|margin)') then
    raise exception 'ASSERTION FAILED: job_bookings carries a money-named column';
  end if;
end;
$$;

notify pgrst, 'reload schema';

select '0121 APPLIED — now run supabase/tests/0121_booking_missed_test.sql' as result;
