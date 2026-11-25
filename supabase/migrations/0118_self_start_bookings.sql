-- ============================================================================
-- Technicians start work on a job themselves; the booking follows the clock.
--
-- STATUS: DRAFT — NOT APPLIED
--
-- WHY (Justin, 25 Nov 2026)
-- "Quite often we have technicians in the area and they can pop in and see a
-- job needs something done. We need them to be able to search the job, clock
-- onto it, but when they do so, we need it to show up in schedule rather than
-- it being very office heavy." And: "It is also critical that they clock on to
-- the correct cost centre." His decisions: the booking runs from clock-on to
-- clock-off; any open job; they pick the stage; the office sees an "Added by
-- technician" tag on the schedule (no push).
--
-- WHAT THIS DOES
--   1. job_bookings.clock_entry_id — the time entry a SELF-STARTED booking
--      follows. Null for every booking the office makes. Unique when set.
--   2. self_start_job_booking(booking id, job id, cost centre id, entry id) —
--      SECURITY DEFINER, executable by `authenticated`. job_bookings stays
--      office-written by RLS (0079); this is the one narrow door for a
--      technician, and it decides everything itself:
--        * the caller is an ACTIVE TECHNICIAN, not a limited-access account
--          (0110 — the App Store reviewer sees only its own jobs);
--        * the job exists and is open (0096's sentence, errcode MJ001);
--        * the cost centre is one of THAT job's PO lines and not completed
--          (0095);
--        * the booking is the CALLER's own (staff_id = created_by = auth.uid()),
--          today, from now (to the minute), no end yet;
--        * idempotent on the client's booking id: a retry returns the same row.
--      0079's triggers then put the caller on the crew (so RLS 0074 lets their
--      clock-on in) — with assigned_by = the caller, so 0077's "New job
--      assigned" push skips them (it never pushes your own assignment). On a
--      job with no lead, 0059 makes them the lead; 0074 refuses a technician
--      setting jobs.assigned_to, so that one insert runs with the role claim
--      set to service_role (see the function).
--   3. Trigger time_entries_follow_booking: when the linked entry is written,
--      the booking's start becomes its clock_in and its end its clock_out. So
--      EVERY clock-off path — the phone's button, the outbox replaying an
--      offline clock-off, the web Time tab, an office correction, the
--      geofence, a clock prompt — ends the booking with no client code. The
--      write runs as a follow-on (app.booking_sync = 'on', like 0079's own
--      writes), so 0096 doesn't refuse it when the job was signed off before
--      the clock-off (sign-off closes the job, then clocks the signer off).
--   4. po_cost_centers_public gains completed_at (no money), so a technician's
--      phone can leave a completed stage out of its clock-on picker.
--
-- "ADDED BY TECHNICIAN" on the boards is read from created_by = staff_id with
-- a technician creator (created_by exists since 0079), so the readers need no
-- new column and work the same before and after this migration.
--
-- NOT CHANGED: job_bookings RLS (still office/admin writes), the sync streams
-- (tech_job_bookings lists its columns and needs none of these;
-- office_job_bookings is job_bookings.* and carries clock_entry_id by itself),
-- 0079 / 0096 triggers.
--
-- APPLY: paste this file → paste supabase/tests/0118_self_start_bookings_test.sql
-- (needs an active technician and an active office/admin) and trust only
-- "0118 PASSED" → mark this header applied and add the ledger row. No PowerSync
-- redeploy. Before it is applied, POST /api/jobs/[id]/self-start answers that
-- starting work isn't switched on yet, and nothing else changes.
-- ============================================================================

do $$
begin
  if to_regclass('public.job_bookings') is null then
    raise exception '0118 needs 0079 (job_bookings) applied first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'po_cost_centers' and column_name = 'completed_at') then
    raise exception '0118 needs 0095 (po_cost_centers.completed_at) applied first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles' and column_name = 'limited_access') then
    raise exception '0118 needs 0110 (profiles.limited_access) applied first';
  end if;
  if to_regprocedure('public.job_status_is_closed(text)') is null then
    raise exception '0118 needs 0096 (job_status_is_closed) applied first';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The link
-- ---------------------------------------------------------------------------
alter table job_bookings add column if not exists clock_entry_id uuid;

comment on column job_bookings.clock_entry_id is
  'The time entry a technician''s self-started booking follows (0118): its clock_in is the '
  'booking''s start, its clock_out the end. Null for bookings the office makes. No FK: the '
  'booking is made before the phone''s queued clock-on reaches the server.';

create unique index if not exists job_bookings_clock_entry_idx
  on job_bookings (clock_entry_id) where clock_entry_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Follow the clock (helper + trigger)
-- ---------------------------------------------------------------------------
create or replace function follow_clock_entry(p_entry_id uuid, p_staff_id uuid, p_clock_in timestamptz, p_clock_out timestamptz)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  prev text := coalesce(current_setting('app.booking_sync', true), '');
begin
  if p_entry_id is null or p_clock_in is null then
    return;
  end if;
  -- The unique index makes this a single lookup; nearly every entry has no booking.
  if not exists (select 1 from job_bookings where clock_entry_id = p_entry_id) then
    return;
  end if;
  perform set_config('app.booking_sync', 'on', true);
  update job_bookings
     set starts_at = p_clock_in,
         ends_at = p_clock_out
   where clock_entry_id = p_entry_id
     -- An entry the office re-attributed to someone else stops steering this booking.
     and staff_id is not distinct from p_staff_id
     and (starts_at is distinct from p_clock_in or ends_at is distinct from p_clock_out);
  perform set_config('app.booking_sync', prev, true);
end;
$$;

create or replace function time_entries_follow_booking()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and new.clock_in is not distinct from old.clock_in
     and new.clock_out is not distinct from old.clock_out
     and new.staff_id is not distinct from old.staff_id then
    return null;
  end if;
  perform follow_clock_entry(new.id, new.staff_id, new.clock_in, new.clock_out);
  return null;
end;
$$;

drop trigger if exists time_entries_follow_booking on time_entries;
create trigger time_entries_follow_booking
  after insert or update of clock_in, clock_out, staff_id on time_entries
  for each row execute function time_entries_follow_booking();

-- ---------------------------------------------------------------------------
-- 3. The technician's door
-- ---------------------------------------------------------------------------
create or replace function self_start_job_booking(
  p_booking_id uuid,
  p_job_id uuid,
  p_cost_center_id uuid,
  p_entry_id uuid
)
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
  v_status text;
  v_number int;
  v_completed timestamptz;
  v_row job_bookings;
  v_entry record;
  v_claims text;
  v_claim_role text;
begin
  if v_uid is null or p_booking_id is null or p_job_id is null or p_entry_id is null then
    raise exception 'Missing details to start work.' using errcode = 'MJ110';
  end if;

  select role, coalesce(is_active, true), coalesce(limited_access, false)
    into v_role, v_active, v_limited
    from profiles where id = v_uid;
  if v_role is distinct from 'technician' or not v_active or v_limited then
    raise exception 'Only technicians can start work on a job this way.' using errcode = 'MJ111';
  end if;

  -- A retry of the same request: answer with what was made.
  select * into v_row from job_bookings where id = p_booking_id;
  if found then
    if v_row.staff_id is distinct from v_uid or v_row.job_id <> p_job_id
       or v_row.clock_entry_id is distinct from p_entry_id then
      raise exception 'That booking isn''t yours.' using errcode = 'MJ112';
    end if;
    return v_row;
  end if;

  if exists (select 1 from job_bookings where clock_entry_id = p_entry_id) then
    raise exception 'That clock-on already has a booking.' using errcode = 'MJ112';
  end if;

  select status, job_number into v_status, v_number from jobs where id = p_job_id;
  if not found then
    raise exception 'Job not found.' using errcode = 'MJ113';
  end if;
  if job_status_is_closed(v_status) then
    raise exception 'Job #% is %. A % job can''t be scheduled — reopen it first.', v_number, v_status, v_status
      using errcode = 'MJ001';
  end if;

  select pcc.completed_at into v_completed
    from po_cost_centers pcc
    join purchase_orders po on po.id = pcc.po_id
   where pcc.id = p_cost_center_id and po.job_id = p_job_id;
  if not found then
    raise exception 'Pick one of this job''s cost centres.' using errcode = 'MJ114';
  end if;
  if v_completed is not null then
    raise exception 'That stage is already complete — pick another, or ask the office.' using errcode = 'MJ115';
  end if;

  -- 0079 derives the crew from the booking, and 0059's sync_job_primary_assignee
  -- then makes the caller the job's lead when it has none. 0074's
  -- enforce_job_assignment_office_only refuses any 'authenticated' caller who
  -- isn't office/admin changing jobs.assigned_to, so the insert runs with the
  -- role claim set to service_role (sub unchanged: auth.uid() is still the
  -- caller, so 0077 still skips pushing them their own assignment). The checks
  -- above are the authorization; the claim is put back straight after.
  v_claims := current_setting('request.jwt.claims', true);
  v_claim_role := current_setting('request.jwt.claim.role', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text, 'role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  insert into job_bookings (id, job_id, staff_id, cost_center_id, starts_at, ends_at, daily, all_day, created_by, clock_entry_id)
  values (p_booking_id, p_job_id, v_uid, p_cost_center_id, date_trunc('minute', now()), null, false, false, v_uid, p_entry_id);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.role', coalesce(v_claim_role, ''), true);

  -- The clock-on already reached the server (a retry after it synced): line up now.
  select id, staff_id, clock_in, clock_out into v_entry from time_entries where id = p_entry_id;
  if found then
    perform follow_clock_entry(v_entry.id, v_entry.staff_id, v_entry.clock_in, v_entry.clock_out);
  end if;

  select * into v_row from job_bookings where id = p_booking_id;
  return v_row;
end;
$$;

comment on function self_start_job_booking(uuid, uuid, uuid, uuid) is
  'A technician books THEMSELVES onto an open job from now, on one of its open stages, '
  'linked to the clock-on that follows (0118). The only way a technician writes job_bookings.';

revoke execute on function follow_clock_entry(uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function time_entries_follow_booking() from public, anon, authenticated;
revoke execute on function self_start_job_booking(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function self_start_job_booking(uuid, uuid, uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Stage completion for technicians (0110's view, completed_at appended)
-- ---------------------------------------------------------------------------
create or replace view po_cost_centers_public with (security_barrier = true) as
  select id, po_id, name, code, allocated_hours, sort_order, created_at, completed_at
  from po_cost_centers pcc
  where (select not is_limited_account())
     or exists (select 1 from purchase_orders po
                 where po.id = pcc.po_id and user_can_manage_job(po.job_id::text));

grant select on po_cost_centers_public to authenticated;
revoke all on po_cost_centers_public from anon;

-- ---------------------------------------------------------------------------
-- Assert the end state
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
  cols text;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'job_bookings' and column_name = 'clock_entry_id') then
    raise exception 'ASSERTION FAILED: job_bookings.clock_entry_id missing';
  end if;

  select count(*) into n from pg_trigger
   where tgrelid = 'time_entries'::regclass and not tgisinternal
     and tgname = 'time_entries_follow_booking' and tgenabled <> 'D';
  if n <> 1 then
    raise exception 'ASSERTION FAILED: time_entries_follow_booking trigger missing or disabled';
  end if;

  if not (select prosecdef from pg_proc where oid = 'public.self_start_job_booking(uuid, uuid, uuid, uuid)'::regprocedure) then
    raise exception 'ASSERTION FAILED: self_start_job_booking is not SECURITY DEFINER';
  end if;
  if has_function_privilege('anon', 'public.self_start_job_booking(uuid, uuid, uuid, uuid)', 'execute') then
    raise exception 'ASSERTION FAILED: anon can run self_start_job_booking';
  end if;
  if not has_function_privilege('authenticated', 'public.self_start_job_booking(uuid, uuid, uuid, uuid)', 'execute') then
    raise exception 'ASSERTION FAILED: authenticated cannot run self_start_job_booking';
  end if;
  if has_function_privilege('authenticated', 'public.follow_clock_entry(uuid, uuid, timestamptz, timestamptz)', 'execute') then
    raise exception 'ASSERTION FAILED: authenticated can run follow_clock_entry';
  end if;

  -- job_bookings is still written by office/admin only (0079's four policies, unchanged).
  select count(*) into n from pg_policy
   where polrelid = 'job_bookings'::regclass and polcmd in ('a', 'w', 'd', '*')
     and position('is_office_or_admin' in coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '')) = 0;
  if n > 0 then
    raise exception 'ASSERTION FAILED: a job_bookings write policy is not office/admin';
  end if;

  select string_agg(column_name, ',' order by ordinal_position) into cols
    from information_schema.columns where table_schema = 'public' and table_name = 'po_cost_centers_public';
  if cols is distinct from 'id,po_id,name,code,allocated_hours,sort_order,created_at,completed_at' then
    raise exception 'ASSERTION FAILED: po_cost_centers_public columns are %', cols;
  end if;
  if position('is_limited_account' in pg_get_viewdef('public.po_cost_centers_public'::regclass)) = 0 then
    raise exception 'ASSERTION FAILED: po_cost_centers_public no longer filters limited accounts';
  end if;
  if has_table_privilege('anon', 'public.po_cost_centers_public', 'select') then
    raise exception 'ASSERTION FAILED: anon can read po_cost_centers_public';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'po_cost_centers_public'
                and column_name ~* '(amount|value|price|cost|rate|total|gst|margin)') then
    raise exception 'ASSERTION FAILED: po_cost_centers_public carries a money-named column';
  end if;
end;
$$;

notify pgrst, 'reload schema';

select '0118 APPLIED — now run supabase/tests/0118_self_start_bookings_test.sql' as result;
