-- ============================================================================
-- Import staff pay rates and leave from Xero Payroll.
--
-- STATUS: DRAFT — NOT APPLIED. Gate test:
-- supabase/tests/0101_xero_payroll_import_test.sql
--
-- WHY (Justin, 15 Nov 2026): pay is run entirely through Xero Payroll, but
-- the app's staff cost profiles were typed in by hand — 4 of 11 active staff
-- had a wage and there was no leave at all, so labour on every job was costed
-- from guesses. Staff → "Import from Xero" pulls each person's pay rate, super
-- and ordinary hours, plus their approved leave, shows it next to what the app
-- has, and writes only what an admin ticks. On demand only — no schedule
-- (Justin: "I don't want things just running for no reason").
--
-- WHAT IT ADDS
--   staff_cost_profiles.xero_employee_id  the Xero employee this person is
--       (unique). Remembered after the first import so later imports
--       don't have to match by email/name again. Admin-only, like the rest of
--       the table.
--   staff_leave.xero_leave_application_id  the Xero leave this row came from
--       (unique), so re-importing never duplicates leave.
--   staff_leave leave_type 'long_service' — Xero records it separately and
--       folding it into 'other' would hide it.
--   staff_cost_profiles.super_rate default 12 — the Super Guarantee rate since
--       1 July 2025 (it was 11.5). Existing rows are not changed here; the
--       import updates them from Xero.
-- ============================================================================

alter table staff_cost_profiles add column if not exists xero_employee_id text;
create unique index if not exists staff_cost_profiles_xero_employee_uidx
  on staff_cost_profiles (xero_employee_id) where xero_employee_id is not null;
comment on column staff_cost_profiles.xero_employee_id is
  'Xero Payroll EmployeeID for this person (0101). Set by the Xero import.';

alter table staff_cost_profiles alter column super_rate set default 12;

alter table staff_leave add column if not exists xero_leave_application_id text;
create unique index if not exists staff_leave_xero_application_uidx
  on staff_leave (xero_leave_application_id) where xero_leave_application_id is not null;
comment on column staff_leave.xero_leave_application_id is
  'Xero Payroll LeaveApplicationID this row was imported from (0101). Null = entered in the app.';

do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.staff_leave'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%leave_type%'
  loop
    execute format('alter table public.staff_leave drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table staff_leave add constraint staff_leave_leave_type_check
  check (leave_type in ('sick', 'annual', 'public_holiday', 'long_service', 'other'));

notify pgrst, 'reload schema';
