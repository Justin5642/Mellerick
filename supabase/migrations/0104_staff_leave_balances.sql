-- ============================================================================
-- Leave balances, imported from Xero Payroll.
--
-- STATUS: DRAFT — NOT APPLIED. Gate test supabase/tests/0104_staff_leave_balances_test.sql.
--
-- WHY (Justin, 15 Nov 2026): the Xero import (0101) brought in pay rates and
-- leave TAKEN, but not what each person has LEFT. Xero holds the balances —
-- they come back on the same employee record the import already reads, so no
-- new Xero permission is needed. Staff → Import from Xero now shows each
-- person's balances next to what the app has and saves the ones ticked. On
-- demand only, like the rest of the import.
--
-- WHAT IT ADDS
--   staff_leave_balances   one row per person per Xero leave type.
--     hours        the balance in hours, as Xero holds it (can be negative —
--                  leave taken in advance).
--     leave_type   the app's category (annual, sick, long_service, …) so the
--                  app can show "annual leave left" without knowing Xero's
--                  type names.
--     as_of        the day it was imported. A balance is a snapshot; it is
--                  only as current as the last import.
--   Admin-only, like staff_leave and staff_cost_profiles (0014).
-- ============================================================================

create table if not exists staff_leave_balances (
  staff_id uuid not null references profiles(id) on delete cascade,
  xero_leave_type_id text not null,
  leave_name text not null,
  leave_type text not null default 'other'
    check (leave_type in ('sick', 'annual', 'public_holiday', 'long_service', 'other')),
  hours numeric(8,2) not null,
  as_of date not null default current_date,
  imported_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  primary key (staff_id, xero_leave_type_id)
);

alter table staff_leave_balances enable row level security;
drop policy if exists "Admin can manage staff leave balances" on staff_leave_balances;
create policy "Admin can manage staff leave balances" on staff_leave_balances for all
  using (is_admin(auth.uid())) with check (is_admin(auth.uid()));

comment on table staff_leave_balances is
  'Leave balance per person per Xero leave type, imported from Xero Payroll (0104). A snapshot as of as_of. Admin only.';

notify pgrst, 'reload schema';
