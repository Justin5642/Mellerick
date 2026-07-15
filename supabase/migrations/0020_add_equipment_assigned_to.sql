-- =============================================
-- ASSIGN EQUIPMENT (VEHICLES) TO A STAFF MEMBER
-- Run this once in the Supabase SQL editor.
--
-- Purpose: some vehicles are effectively "owned" by a single technician
-- (they take it home, it's their daily driver for the job), so that
-- vehicle's true running cost ($/hour, from migration 0016's cost
-- profile) should be folded into that technician's loaded hourly cost
-- rate (migration 0014's staff_cost_profiles), instead of sitting as a
-- disconnected manual guess inside staff_cost_profiles.annual_fixed_oncosts.
--
-- Reuses the same single-FK "assign a resource to a staff member" pattern
-- already used for jobs.assigned_to -- a vehicle is driven by one
-- technician at a time in this business, not shared concurrently, so a
-- join table would be unnecessary complexity.
-- =============================================

alter table equipment add column if not exists assigned_to uuid references profiles(id);

create index if not exists equipment_assigned_to_idx on equipment(assigned_to);

comment on column equipment.assigned_to is
  'Technician this vehicle/equipment is assigned to (if any). Used to fold this item''s $/hour cost (see lib/equipment-cost.ts) into that technician''s loaded hourly cost rate (see lib/staff-cost.ts), so their true cost-per-hour reflects the actual vehicle they use rather than a manual estimate.';
