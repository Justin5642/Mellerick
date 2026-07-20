create extension if not exists "uuid-ossp";

create table if not exists profiles (
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
drop policy if exists "Users can view all profiles" on profiles;
create policy "Users can view all profiles" on profiles for select using (auth.role() = 'authenticated');
drop policy if exists "Users can update own profile" on profiles;
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);

create table if not exists customers (
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

create table if not exists sites (
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

create table if not exists pricing_items (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  description text,
  category text not null,
  pricing_type text not null check (pricing_type in ('flat_rate', 'hourly', 'material')),
  unit_price numeric(10,2) not null,
  unit text default 'each',
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table pricing_items enable row level security;
drop policy if exists "Authenticated users can manage pricing" on pricing_items;
create policy "Authenticated users can manage pricing" on pricing_items for all using (auth.role() = 'authenticated');

create table if not exists jobs (
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

create table if not exists job_items (
  id uuid default uuid_generate_v4() primary key,
  job_id uuid references jobs(id) on delete cascade not null,
  pricing_item_id uuid references pricing_items(id),
  name text not null,
  description text,
  quantity numeric(10,2) default 1,
  unit_price numeric(10,2) not null,
  total numeric(10,2) generated always as (quantity * unit_price) stored,
  created_at timestamptz default now()
);

alter table job_items enable row level security;
drop policy if exists "Authenticated users can manage job items" on job_items;
create policy "Authenticated users can manage job items" on job_items for all using (auth.role() = 'authenticated');

create table if not exists quotes (
  id uuid default uuid_generate_v4() primary key,
  quote_number serial unique,
  customer_id uuid references customers(id) not null,
  site_id uuid references sites(id),
  job_id uuid references jobs(id),
  title text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'declined', 'expired')),
  subtotal numeric(10,2) default 0,
  tax_rate numeric(5,2) default 10,
  tax_amount numeric(10,2) default 0,
  total numeric(10,2) default 0,
  valid_until date,
  notes text,
  xero_quote_id text,
  created_by uuid references profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table quotes enable row level security;
drop policy if exists "Authenticated users can manage quotes" on quotes;
create policy "Authenticated users can manage quotes" on quotes for all using (auth.role() = 'authenticated');

create table if not exists quote_items (
  id uuid default uuid_generate_v4() primary key,
  quote_id uuid references quotes(id) on delete cascade not null,
  pricing_item_id uuid references pricing_items(id),
  name text not null,
  description text,
  quantity numeric(10,2) default 1,
  unit_price numeric(10,2) not null,
  total numeric(10,2) generated always as (quantity * unit_price) stored,
  created_at timestamptz default now()
);

alter table quote_items enable row level security;
drop policy if exists "Authenticated users can manage quote items" on quote_items;
create policy "Authenticated users can manage quote items" on quote_items for all using (auth.role() = 'authenticated');

create table if not exists invoices (
  id uuid default uuid_generate_v4() primary key,
  invoice_number serial unique,
  customer_id uuid references customers(id) not null,
  job_id uuid references jobs(id),
  quote_id uuid references quotes(id),
  title text not null,
  status text not null default 'draft' check (status in ('draft', 'sent', 'paid', 'overdue', 'cancelled')),
  subtotal numeric(10,2) default 0,
  tax_rate numeric(5,2) default 10,
  tax_amount numeric(10,2) default 0,
  total numeric(10,2) default 0,
  amount_paid numeric(10,2) default 0,
  due_date date,
  paid_at timestamptz,
  notes text,
  xero_invoice_id text,
  created_by uuid references profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table invoices enable row level security;
drop policy if exists "Authenticated users can manage invoices" on invoices;
create policy "Authenticated users can manage invoices" on invoices for all using (auth.role() = 'authenticated');

create table if not exists invoice_items (
  id uuid default uuid_generate_v4() primary key,
  invoice_id uuid references invoices(id) on delete cascade not null,
  pricing_item_id uuid references pricing_items(id),
  name text not null,
  description text,
  quantity numeric(10,2) default 1,
  unit_price numeric(10,2) not null,
  total numeric(10,2) generated always as (quantity * unit_price) stored,
  created_at timestamptz default now()
);

alter table invoice_items enable row level security;
drop policy if exists "Authenticated users can manage invoice items" on invoice_items;
create policy "Authenticated users can manage invoice items" on invoice_items for all using (auth.role() = 'authenticated');

create table if not exists google_tokens (
  id uuid default uuid_generate_v4() primary key,
  access_token text not null,
  refresh_token text not null,
  token_expiry timestamptz not null,
  google_email text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table google_tokens enable row level security;
drop policy if exists "Authenticated users can manage google tokens" on google_tokens;
create policy "Authenticated users can manage google tokens" on google_tokens for all using (auth.role() = 'authenticated');

create table if not exists xero_tokens (
  id uuid default uuid_generate_v4() primary key,
  access_token text not null,
  refresh_token text not null,
  token_expiry timestamptz not null,
  tenant_id text,
  tenant_name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Grant PostgREST roles access to all tables created above.
-- Supabase's default-privilege setup only fires when migrations run normally;
-- in CI we apply this file directly via psql, so the grants must be explicit.
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines in schema public to anon, authenticated, service_role;
