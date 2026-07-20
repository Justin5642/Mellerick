-- =============================================
-- MELLERICK APP — BASELINE MIGRATION (0000)
-- =============================================
-- This is the initial schema, promoted from supabase/schema.sql so the
-- migration chain is self-contained: `supabase start` / `db reset` applies
-- this first, then 0001+ layer on top. Previously the migrations assumed
-- schema.sql had already been run by hand, so a from-scratch rebuild failed
-- with `relation "customers" does not exist`.
--
-- PRODUCTION NOTE: the prod database already has these tables (built from the
-- original schema.sql). Do NOT re-run this migration against prod — mark it
-- applied with `supabase migration repair --status applied 0000` so the CLI
-- history is coherent without recreating existing tables.
--
-- Keep this in sync with supabase/schema.sql (kept as the human-readable
-- reference).

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- =============================================
-- PROFILES (extends Supabase auth.users)
-- =============================================
create table profiles (
  id uuid references auth.users on delete cascade primary key,
  full_name text not null,
  email text not null,
  phone text,
  role text not null check (role in ('admin', 'office', 'technician')),
  avatar_url text,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table profiles enable row level security;

create policy "Users can view all profiles" on profiles for select using (auth.role() = 'authenticated');
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);
create policy "Admin can manage profiles" on profiles for all using (
  exists (select 1 from profiles where id = auth.uid() and role = 'admin')
);

-- =============================================
-- CUSTOMERS
-- =============================================
create table customers (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  email text,
  phone text,
  mobile text,
  company text,
  abn text,
  notes text,
  is_active boolean default true,
  created_by uuid references profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table customers enable row level security;
create policy "Authenticated users can manage customers" on customers for all using (auth.role() = 'authenticated');

-- =============================================
-- SITES (job locations linked to customers)
-- =============================================
create table sites (
  id uuid default uuid_generate_v4() primary key,
  customer_id uuid references customers(id) on delete cascade not null,
  name text not null,
  address_line1 text not null,
  address_line2 text,
  suburb text not null,
  state text not null,
  postcode text not null,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table sites enable row level security;
create policy "Authenticated users can manage sites" on sites for all using (auth.role() = 'authenticated');

-- =============================================
-- PRICING ITEMS (rate cards)
-- =============================================
create table pricing_items (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  description text,
  category text not null,
  pricing_type text not null check (pricing_type in ('flat_rate', 'hourly', 'material')),
  unit_price decimal(10,2) not null,
  unit text default 'each',
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table pricing_items enable row level security;
create policy "Authenticated users can manage pricing" on pricing_items for all using (auth.role() = 'authenticated');

-- =============================================
-- JOBS
-- =============================================
create table jobs (
  id uuid default uuid_generate_v4() primary key,
  job_number serial unique,
  customer_id uuid references customers(id) not null,
  site_id uuid references sites(id),
  assigned_to uuid references profiles(id),
  title text not null,
  description text,
  status text not null default 'pending' check (status in ('pending', 'scheduled', 'in_progress', 'completed', 'cancelled', 'on_hold')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  job_type text default 'service' check (job_type in ('service', 'installation', 'maintenance', 'emergency', 'quote')),
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  actual_start timestamptz,
  actual_end timestamptz,
  google_event_id text,
  notes text,
  completion_notes text,
  created_by uuid references profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table jobs enable row level security;
create policy "Authenticated users can manage jobs" on jobs for all using (auth.role() = 'authenticated');

-- =============================================
-- JOB ITEMS (line items on a job)
-- =============================================
create table job_items (
  id uuid default uuid_generate_v4() primary key,
  job_id uuid references jobs(id) on delete cascade not null,
  pricing_item_id uuid references pricing_items(id),
  name text not null,
  description text,
  quantity decimal(10,2) default 1,
  unit_price decimal(10,2) not null,
  total decimal(10,2) generated always as (quantity * unit_price) stored,
  created_at timestamptz default now()
);

alter table job_items enable row level security;
create policy "Authenticated users can manage job items" on job_items for all using (auth.role() = 'authenticated');

-- =============================================
-- JOB PHOTOS
-- =============================================
create table job_photos (
  id uuid default uuid_generate_v4() primary key,
  job_id uuid references jobs(id) on delete cascade not null,
  uploaded_by uuid references profiles(id),
  storage_path text not null,
  caption text,
  photo_type text default 'general' check (photo_type in ('before', 'after', 'general', 'signature')),
  created_at timestamptz default now()
);

alter table job_photos enable row level security;
create policy "Authenticated users can manage job photos" on job_photos for all using (auth.role() = 'authenticated');

-- =============================================
-- QUOTES
-- =============================================
create table quotes (
  id uuid default uuid_generate_v4() primary key,
  quote_number serial unique,
  customer_id uuid references customers(id) not null,
  site_id uuid references sites(id),
  job_id uuid references jobs(id),
  title text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'declined', 'expired')),
  subtotal decimal(10,2) default 0,
  tax_rate decimal(5,2) default 10,
  tax_amount decimal(10,2) default 0,
  total decimal(10,2) default 0,
  valid_until date,
  notes text,
  xero_quote_id text,
  created_by uuid references profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table quotes enable row level security;
create policy "Authenticated users can manage quotes" on quotes for all using (auth.role() = 'authenticated');

-- =============================================
-- QUOTE ITEMS
-- =============================================
create table quote_items (
  id uuid default uuid_generate_v4() primary key,
  quote_id uuid references quotes(id) on delete cascade not null,
  pricing_item_id uuid references pricing_items(id),
  name text not null,
  description text,
  quantity decimal(10,2) default 1,
  unit_price decimal(10,2) not null,
  total decimal(10,2) generated always as (quantity * unit_price) stored,
  created_at timestamptz default now()
);

alter table quote_items enable row level security;
create policy "Authenticated users can manage quote items" on quote_items for all using (auth.role() = 'authenticated');

-- =============================================
-- INVOICES
-- =============================================
create table invoices (
  id uuid default uuid_generate_v4() primary key,
  invoice_number serial unique,
  customer_id uuid references customers(id) not null,
  job_id uuid references jobs(id),
  quote_id uuid references quotes(id),
  title text not null,
  status text not null default 'draft' check (status in ('draft', 'sent', 'paid', 'overdue', 'cancelled')),
  subtotal decimal(10,2) default 0,
  tax_rate decimal(5,2) default 10,
  tax_amount decimal(10,2) default 0,
  total decimal(10,2) default 0,
  amount_paid decimal(10,2) default 0,
  due_date date,
  paid_at timestamptz,
  notes text,
  xero_invoice_id text,
  created_by uuid references profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table invoices enable row level security;
create policy "Authenticated users can manage invoices" on invoices for all using (auth.role() = 'authenticated');

-- =============================================
-- INVOICE ITEMS
-- =============================================
create table invoice_items (
  id uuid default uuid_generate_v4() primary key,
  invoice_id uuid references invoices(id) on delete cascade not null,
  pricing_item_id uuid references pricing_items(id),
  name text not null,
  description text,
  quantity decimal(10,2) default 1,
  unit_price decimal(10,2) not null,
  total decimal(10,2) generated always as (quantity * unit_price) stored,
  created_at timestamptz default now()
);

alter table invoice_items enable row level security;
create policy "Authenticated users can manage invoice items" on invoice_items for all using (auth.role() = 'authenticated');

-- =============================================
-- INVENTORY
-- =============================================
create table inventory (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  sku text unique,
  description text,
  category text,
  unit text default 'each',
  quantity_on_hand decimal(10,2) default 0,
  reorder_level decimal(10,2) default 0,
  unit_cost decimal(10,2) default 0,
  unit_sell decimal(10,2) default 0,
  supplier text,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table inventory enable row level security;
create policy "Authenticated users can manage inventory" on inventory for all using (auth.role() = 'authenticated');

-- =============================================
-- TRIGGERS — auto-update updated_at
-- =============================================
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger update_profiles_updated_at before update on profiles for each row execute function update_updated_at();
create trigger update_customers_updated_at before update on customers for each row execute function update_updated_at();
create trigger update_sites_updated_at before update on sites for each row execute function update_updated_at();
create trigger update_jobs_updated_at before update on jobs for each row execute function update_updated_at();
create trigger update_quotes_updated_at before update on quotes for each row execute function update_updated_at();
create trigger update_invoices_updated_at before update on invoices for each row execute function update_updated_at();
create trigger update_inventory_updated_at before update on inventory for each row execute function update_updated_at();
create trigger update_pricing_updated_at before update on pricing_items for each row execute function update_updated_at();

-- =============================================
-- AUTO-CREATE PROFILE ON SIGNUP
-- =============================================
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', 'New User'),
    new.email,
    coalesce(new.raw_user_meta_data->>'role', 'technician')
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- =============================================
-- STORAGE BUCKET FOR JOB PHOTOS
-- =============================================
insert into storage.buckets (id, name, public) values ('job-photos', 'job-photos', false);

create policy "Authenticated users can upload job photos"
  on storage.objects for insert
  with check (bucket_id = 'job-photos' and auth.role() = 'authenticated');

create policy "Authenticated users can view job photos"
  on storage.objects for select
  using (bucket_id = 'job-photos' and auth.role() = 'authenticated');

-- =============================================
-- GOOGLE CALENDAR TOKENS (single connected account)
-- =============================================
create table google_tokens (
  id uuid default uuid_generate_v4() primary key,
  access_token text not null,
  refresh_token text not null,
  token_expiry timestamptz not null,
  google_email text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table google_tokens enable row level security;
create policy "Authenticated users can manage google tokens" on google_tokens for all using (auth.role() = 'authenticated');

-- =============================================
-- TIME ENTRIES (technician clock in/out per job)
-- =============================================
-- NOTE: this table and xero_tokens below were originally created directly in
-- the production database and were missing from this baseline — so the
-- versioned SQL could not rebuild the schema from scratch. They are restored
-- here to match how the app uses them; later migrations layer on the columns
-- they add (hours 0003, entry_type/travel 0005, cost_center 0013, edit audit
-- 0015, rate_override 0025) via `add column if not exists`, and the office/
-- admin-manage-all policy (0030). Column set reconstructed from code plus those
-- migrations; verify against a production dump before applying to prod.
create table time_entries (
  id uuid default uuid_generate_v4() primary key,
  job_id uuid references jobs(id) on delete cascade not null,
  staff_id uuid references profiles(id) not null,
  clock_in timestamptz not null,
  clock_out timestamptz,
  auto_clocked boolean default false,
  created_at timestamptz default now()
);

alter table time_entries enable row level security;
-- Baseline: every authenticated user manages time entries (techs log their own);
-- migration 0030 adds the office/admin-manage-all policy on top.
create policy "Authenticated users can manage time entries" on time_entries for all using (auth.role() = 'authenticated');

-- =============================================
-- XERO TOKENS (single connected org — mirrors google_tokens)
-- =============================================
-- See the note on time_entries above. Later migrations add
-- default_expense_account_code / default_sales_account_code (0033) and
-- xero_invoice_last_synced_at (0018). RLS is tightened to office/admin in
-- migration 0034 — this table holds Xero OAuth tokens and must not be readable
-- by technicians.
create table xero_tokens (
  id uuid default uuid_generate_v4() primary key,
  access_token text not null,
  refresh_token text not null,
  token_expiry timestamptz not null,
  tenant_id text,
  tenant_name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table xero_tokens enable row level security;
create policy "Authenticated users can manage xero tokens" on xero_tokens for all using (auth.role() = 'authenticated');
