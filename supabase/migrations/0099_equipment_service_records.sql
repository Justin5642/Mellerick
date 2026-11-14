-- ============================================================================
-- Service records for fleet vehicles and plant.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-11-14, via SQL editor). Gate test
-- supabase/tests/0099_equipment_service_records_test.sql passed.
--
-- WHY (Justin, 14 Nov 2026 — Fleet department): log every service against each
-- vehicle and piece of plant, so its history, odometer / engine hours and when
-- the next service is due are on record — not just what it cost.
--
-- Until now a "service" was an equipment_expenses row with category 'service':
-- a supplier, an amount and a receipt, but no odometer, no hours, no record of
-- what was done and nothing about the next one. This table holds the service
-- itself. The MONEY stays in equipment_expenses (one optional link per record)
-- so the yearly cost summary and the actual cost rate (lib/fleet-costs.ts)
-- count each invoice exactly once.
--
-- ACCESS: everyone signed in can read (technicians drive these vehicles and
-- should see when a service is due; there is no money in this table). Only
-- office/admin can add, change or remove records.
-- ============================================================================

create table if not exists equipment_service_records (
  id uuid primary key default gen_random_uuid(),
  equipment_id uuid not null references equipment(id) on delete cascade,
  service_date date not null default current_date,
  service_type text not null default 'scheduled'
    check (service_type in ('scheduled', 'repair', 'inspection', 'tyres', 'other')),
  odometer_km integer check (odometer_km is null or odometer_km >= 0),
  engine_hours numeric(10,1) check (engine_hours is null or engine_hours >= 0),
  provider text,
  work_done text,
  -- The invoice for this service, if any. The cost lives there, not here.
  expense_id uuid references equipment_expenses(id) on delete set null,
  next_due_date date,
  next_due_km integer check (next_due_km is null or next_due_km >= 0),
  next_due_hours numeric(10,1) check (next_due_hours is null or next_due_hours >= 0),
  logged_by uuid references profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table equipment_service_records is
  'One service, repair or inspection of a fleet item (0099): readings, what was done, and when the next is due. Cost is in the linked equipment_expenses row.';

create index if not exists equipment_service_records_equipment_idx
  on equipment_service_records (equipment_id, service_date desc);
-- One service per invoice, so an expense is never shown against two services.
create unique index if not exists equipment_service_records_expense_uidx
  on equipment_service_records (expense_id) where expense_id is not null;

drop trigger if exists equipment_service_records_updated_at on equipment_service_records;
create trigger equipment_service_records_updated_at
  before update on equipment_service_records
  for each row execute function update_updated_at();

alter table equipment_service_records enable row level security;

drop policy if exists "service records: signed-in users read" on equipment_service_records;
create policy "service records: signed-in users read"
  on equipment_service_records for select to authenticated
  using (true);

drop policy if exists "service records: office/admin add" on equipment_service_records;
create policy "service records: office/admin add"
  on equipment_service_records for insert to authenticated
  with check ((select is_office_or_admin(auth.uid())));

drop policy if exists "service records: office/admin change" on equipment_service_records;
create policy "service records: office/admin change"
  on equipment_service_records for update to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

drop policy if exists "service records: office/admin remove" on equipment_service_records;
create policy "service records: office/admin remove"
  on equipment_service_records for delete to authenticated
  using ((select is_office_or_admin(auth.uid())));

revoke all on equipment_service_records from anon, public;
grant select, insert, update, delete on equipment_service_records to authenticated;

notify pgrst, 'reload schema';
