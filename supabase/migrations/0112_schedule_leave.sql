-- ============================================================================
-- Staff leave on the schedule.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-11-19, via SQL editor; gate test passed).
-- Was: paste, then supabase/tests/0112_schedule_leave_test.sql; trust only a
-- final "0112 PASSED" row.
--
-- WHY (Justin, 17 Nov 2026): when a staff member has sick leave entered, show
-- it on the schedule so nobody books them, and flag bookings already on those
-- days as "Needs reassigning". Office and admin see the full label ("Sick",
-- "Annual leave"…); everyone else sees only "Unavailable", enforced HERE, not
-- just in the UI.
--
-- SOURCE: staff_leave (0014) — the one place leave is entered (Staff → Cost &
-- Leave → Leave Log, admin) or imported (Xero Payroll leave applications,
-- 0101). Nothing new to enter it in. The table stays admin-only; the schedule
-- reads it only through schedule_leave() below.
--
-- WHAT IT ADDS
--   staff_leave.start_time / end_time  optional Melbourne wall-clock hours of
--       a PART day (e.g. 12:00–15:30), the same on each covered day. Both or
--       neither. Null = whole days, or a part day of unknown time (the
--       schedule then treats the whole day as unavailable). Set from the same
--       Leave Log form. Xero imports leave them null.
--   schedule_settings  one row. leave_type_visible_to: who receives the
--       leave TYPE from schedule_leave() — 'office_admin' (default), 'admin'
--       or 'everyone'. Readable by any signed-in user, changed by admin only.
--   schedule_leave(p_from date, p_to date)  SECURITY DEFINER. Leave
--       overlapping the range (≤ 400 days), for every staff member, with
--       ONLY: staff_id, dates, hours, part-day times, and leave_type — the
--       type NULL unless the setting lets the caller see it. id only for an
--       admin (the record is admin-only). notes, created_by and the Xero id
--       are never returned. No rows for an inactive caller or a
--       limited-access account (0110, the App Store reviewer).
--
-- NOT IN POWERSYNC. staff_leave stays out of the publication (0039). The
-- phone reads schedule_leave() online; nothing in sync-streams.yaml changes.
--
-- Safe to merge the app before this is applied: every reader treats a
-- missing function/column (42883 / PGRST202 / 42703) as "no leave".
-- ============================================================================

-- 1. Part-day hours on staff_leave -------------------------------------------
alter table staff_leave add column if not exists start_time time;
alter table staff_leave add column if not exists end_time time;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.staff_leave'::regclass and conname = 'staff_leave_part_day_times_check'
  ) then
    alter table staff_leave add constraint staff_leave_part_day_times_check
      check ((start_time is null) = (end_time is null) and (start_time is null or end_time > start_time));
  end if;
end;
$$;

comment on column staff_leave.start_time is
  'Part day: Melbourne wall-clock start, the same on each covered day (0112). Null with end_time = whole days or unknown hours.';
comment on column staff_leave.end_time is
  'Part day: Melbourne wall-clock end (0112). Set together with start_time.';

-- 2. The setting ---------------------------------------------------------------
create table if not exists schedule_settings (
  id boolean primary key default true check (id),
  leave_type_visible_to text not null default 'office_admin'
    check (leave_type_visible_to in ('office_admin', 'admin', 'everyone')),
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);
insert into schedule_settings (id) values (true) on conflict (id) do nothing;

alter table schedule_settings enable row level security;

do $$
declare
  p record;
begin
  for p in select polname from pg_policy where polrelid = 'public.schedule_settings'::regclass loop
    execute format('drop policy %I on public.schedule_settings', p.polname);
  end loop;
end;
$$;

create policy "Signed-in users read schedule settings" on schedule_settings
  for select to authenticated using (true);
create policy "Admin updates schedule settings" on schedule_settings
  for update to authenticated using (is_admin(auth.uid())) with check (is_admin(auth.uid()));

-- New tables are not exposed by themselves in this project (0088).
revoke all on schedule_settings from anon;
grant select, update on schedule_settings to authenticated;
grant all on schedule_settings to service_role;

comment on table schedule_settings is
  'Company-wide schedule settings, one row (0112). leave_type_visible_to decides who sees the leave type on the schedule.';

-- 3. The read ------------------------------------------------------------------
create or replace function schedule_leave(p_from date, p_to date)
returns table (
  id uuid,
  staff_id uuid,
  start_date date,
  end_date date,
  hours numeric,
  start_time time,
  end_time time,
  leave_type text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_active boolean;
  v_limited boolean;
  v_audience text;
  v_show_type boolean;
begin
  if p_from is null or p_to is null or p_to < p_from then
    return;
  end if;
  if p_to - p_from > 400 then
    raise exception 'schedule_leave: a range of at most 400 days' using errcode = '22023';
  end if;

  select pr.role, coalesce(pr.is_active, true), coalesce(pr.limited_access, false)
    into v_role, v_active, v_limited
    from profiles pr where pr.id = auth.uid();
  if v_role is null or not v_active or v_limited then
    return;
  end if;

  select s.leave_type_visible_to into v_audience from schedule_settings s where s.id;
  v_audience := coalesce(v_audience, 'office_admin');
  v_show_type := case v_audience
    when 'everyone' then true
    when 'admin' then v_role = 'admin'
    else v_role in ('admin', 'office')
  end;

  return query
    select
      case when v_role = 'admin' then l.id else null end,
      l.staff_id,
      l.start_date,
      l.end_date,
      l.hours,
      l.start_time,
      l.end_time,
      case when v_show_type then l.leave_type else null end
    from staff_leave l
    where l.start_date <= p_to and l.end_date >= p_from
    order by l.start_date, l.staff_id;
end;
$$;

revoke all on function schedule_leave(date, date) from public, anon;
grant execute on function schedule_leave(date, date) to authenticated, service_role;

comment on function schedule_leave(date, date) is
  'Leave on the schedule (0112): staff, dates, hours, part-day times; leave_type only for the audience in schedule_settings, else NULL ("Unavailable"). Never notes.';

notify pgrst, 'reload schema';
