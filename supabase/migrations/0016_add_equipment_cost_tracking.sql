-- =============================================
-- EQUIPMENT / FLEET COST TRACKING
-- Run this once in the Supabase SQL editor.
--
-- Purpose: mirrors staff_cost_profiles (migration 0014) but for machinery
-- and vehicles -- purchase cost, depreciation, insurance, maintenance,
-- registration and fuel loaded into a single $/hour figure, so it's
-- possible to see whether owning a truck/excavator outright is actually
-- cheaper than hiring one on demand ("plan viability"), and so equipment
-- use can be costed against a job the same way labour and materials
-- already are (job_expenses, time_entries).
--
-- Unlike staff_cost_profiles (locked to admins because it's payroll data),
-- equipment costs are business overhead, not personal, so the whole table
-- is readable by any authenticated user -- technicians need to see it to
-- pick the right item when logging usage on a job. Only admins can add,
-- edit or remove equipment / change its cost inputs.
-- =============================================

create table if not exists equipment (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  category text not null default 'vehicle'
    check (category in ('vehicle', 'machinery', 'tool', 'other')),
  registration text,
  is_active boolean not null default true,
  purchase_cost numeric(10,2) not null default 0,
  purchase_date date,
  estimated_life_years numeric(5,2) not null default 5,
  insurance_annual numeric(10,2) not null default 0,
  maintenance_annual numeric(10,2) not null default 0,
  registration_annual numeric(10,2) not null default 0,
  other_annual_costs numeric(10,2) not null default 0,
  fuel_cost_per_hour numeric(10,2) not null default 0,
  target_hours_per_year numeric(8,2) not null default 1000,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  updated_by uuid references profiles(id)
);

alter table equipment enable row level security;

create policy "Authenticated can view equipment" on equipment for select using (auth.role() = 'authenticated');
create policy "Admin can add equipment" on equipment for insert with check (is_admin(auth.uid()));
create policy "Admin can update equipment" on equipment for update using (is_admin(auth.uid()));
create policy "Admin can delete equipment" on equipment for delete using (is_admin(auth.uid()));

comment on table equipment is
  'Vehicles/machinery/tools the business owns or maintains. Name/category/registration/cost fields are visible to every authenticated user (not personally sensitive like staff pay) so technicians can pick the right item when logging usage; only admins can create, edit or deactivate rows.';
comment on column equipment.estimated_life_years is 'Expected useful life in years, for straight-line depreciation: purchase_cost / estimated_life_years = annual depreciation.';
comment on column equipment.target_hours_per_year is 'Expected/typical hours of use per year. Used to spread annual fixed costs (depreciation, insurance, maintenance, registration) into a $/hour figure, and to estimate annual fuel spend from fuel_cost_per_hour.';
comment on column equipment.fuel_cost_per_hour is 'Estimated fuel $/hour of operation.';
comment on column equipment.is_active is 'Inactive equipment (sold/written off) is hidden from job-costing pickers but its history stays for reporting.';

create table if not exists equipment_usage_log (
  id uuid default uuid_generate_v4() primary key,
  equipment_id uuid references equipment(id) on delete cascade not null,
  job_id uuid references jobs(id) on delete set null,
  usage_date date not null default current_date,
  hours numeric(6,2) not null,
  notes text,
  logged_by uuid references profiles(id),
  created_at timestamptz default now()
);

alter table equipment_usage_log enable row level security;
create index if not exists equipment_usage_log_equipment_id_idx on equipment_usage_log(equipment_id);
create index if not exists equipment_usage_log_job_id_idx on equipment_usage_log(job_id);

create policy "Authenticated users can manage equipment usage" on equipment_usage_log for all using (auth.role() = 'authenticated');

comment on table equipment_usage_log is
  'Hours a piece of equipment was used, optionally tied to a job (job_id null = general/non-job use, e.g. servicing) so equipment cost (hours * equipment cost-per-hour) can be counted alongside labour and material costs for true job profitability.';
