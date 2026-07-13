-- =============================================
-- STAFF TRUE COST + LEAVE TRACKING
-- Run this once in the Supabase SQL editor.
--
-- Purpose: work out a fully-loaded ($/hour) cost per staff member --
-- wage + super + workers comp + other on-costs -- and separate hours
-- *paid* (worked + sick/annual/other leave) from hours actually
-- *worked*, so job costing and staff efficiency reporting reflect true
-- cost, not just nominal wage. An employee who takes more sick leave
-- than another shows up here as costing more per hour actually
-- delivered, even on an identical wage.
--
-- This data is deliberately NOT columns on `profiles` -- the existing
-- "Users can view all profiles" policy in schema.sql lets every
-- authenticated user (including technicians) read every row of that
-- table, and pay-rate data must never be exposed that way. Both new
-- tables below are locked to admins only, reusing the `is_admin()`
-- helper introduced in migration 0010 to avoid the RLS-recursion issue
-- that a plain "profiles where role = 'admin'" subquery would hit when
-- profiles reference back to itself.
-- =============================================

create table if not exists staff_cost_profiles (
  staff_id uuid references profiles(id) on delete cascade primary key,
  hourly_rate numeric(10,2) not null default 0,
  super_rate numeric(5,2) not null default 11.5,
  workers_comp_rate numeric(5,2) not null default 0,
  leave_loading_rate numeric(5,2) not null default 0,
  annual_fixed_oncosts numeric(10,2) not null default 0,
  target_hours_per_week numeric(5,2) not null default 38,
  updated_at timestamptz default now(),
  updated_by uuid references profiles(id)
);

alter table staff_cost_profiles enable row level security;

create policy "Admin can manage staff cost profiles" on staff_cost_profiles for all using (is_admin(auth.uid()));

comment on table staff_cost_profiles is
  'Admin-only true-cost inputs per staff member (wage, super, on-costs) used to compute a fully-loaded hourly cost rate for job costing and efficiency reporting. Deliberately separate from `profiles`, which every authenticated user can read.';
comment on column staff_cost_profiles.hourly_rate is 'Base wage, $/hour, before super/on-costs.';
comment on column staff_cost_profiles.super_rate is 'Superannuation guarantee, % of wage (default 11.5 -- update as the SG rate changes).';
comment on column staff_cost_profiles.workers_comp_rate is 'Workers compensation insurance, % of wage.';
comment on column staff_cost_profiles.leave_loading_rate is 'Leave loading, % of wage, if applicable under the relevant award.';
comment on column staff_cost_profiles.annual_fixed_oncosts is 'Flat annual $ for costs that do not scale with hours -- vehicle, phone, tools/PPE, training -- spread across paid hours to load into the hourly cost rate.';
comment on column staff_cost_profiles.target_hours_per_week is 'Standard paid hours/week, used to estimate annual paid hours (x52) for spreading fixed on-costs and computing the loaded hourly rate.';

create table if not exists staff_leave (
  id uuid default uuid_generate_v4() primary key,
  staff_id uuid references profiles(id) on delete cascade not null,
  leave_type text not null check (leave_type in ('sick', 'annual', 'public_holiday', 'other')),
  start_date date not null,
  end_date date not null,
  hours numeric(6,2) not null,
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz default now()
);

alter table staff_leave enable row level security;
create index if not exists staff_leave_staff_id_idx on staff_leave(staff_id);
create index if not exists staff_leave_dates_idx on staff_leave(start_date, end_date);

create policy "Admin can manage staff leave" on staff_leave for all using (is_admin(auth.uid()));

comment on table staff_leave is
  'Paid leave taken by staff (sick/annual/public holiday/other), logged by admins. Used alongside time_entries to separate hours paid from hours worked when computing true effective cost per employee.';
