-- =============================================
-- JOB VARIATIONS
-- Run this once in the Supabase SQL editor.
--
-- Purpose: implements CRM spec items "Variations — Auto Approve" and
-- "Variations — Manual Approval". Standard variation types (e.g. Rock
-- Removal, Spoil Removal) carry a preset rate and auto-approve when a
-- crew member logs a quantity + photo. Anything else (a custom/one-off
-- variation) is flagged to admin for manual pricing + approval before
-- the job can be invoiced.
-- =============================================

-- Catalog of standard variation types + their preset per-unit rate.
-- Managed by the office in Settings > Variation Types.
create table if not exists variation_types (
  id uuid default uuid_generate_v4() primary key,
  name text not null unique,
  unit text not null default 'm³',
  rate numeric(10,2) not null default 0,
  auto_approve boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz default now()
);

alter table variation_types enable row level security;
create policy "Authenticated users can manage variation types" on variation_types for all using (auth.role() = 'authenticated');

-- Individual variation instances logged against a job.
create table if not exists job_variations (
  id uuid default uuid_generate_v4() primary key,
  job_id uuid references jobs(id) on delete cascade not null,
  variation_type_id uuid references variation_types(id),
  custom_name text,
  description text,
  quantity numeric(10,2) not null default 0,
  unit text not null default 'unit',
  rate numeric(10,2),
  total_amount numeric(10,2),
  photo_storage_path text,
  status text not null default 'pending_approval'
    check (status in ('auto_approved', 'pending_approval', 'approved', 'rejected')),
  logged_by uuid references profiles(id),
  logged_at timestamptz default now(),
  approved_by uuid references profiles(id),
  approved_at timestamptz,
  admin_notes text,
  created_at timestamptz default now()
);

alter table job_variations enable row level security;
create policy "Authenticated users can manage job variations" on job_variations for all using (auth.role() = 'authenticated');

comment on table variation_types is
  'Preset variation rates (e.g. Rock Removal $/m³, Spoil Removal $/m³) set by the office. auto_approve=true lets crew log a quantity+photo and have it approved instantly; auto_approve=false (or a custom/one-off variation with no variation_type_id) requires office pricing + manual approval before the job can be invoiced.';
