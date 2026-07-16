-- Backflow prevention device tracking + compliance test reporting.
--
-- Mirrors the jobs table's dual-FK pattern (customer_id required, site_id
-- optional) so a device can be tied to a specific site when the customer has
-- several, or just the customer when there's only ever been one address.
--
-- The mechanical check fields captured on the water authorities' actual test
-- sheets (per-device-group check valve/isolation valve/relief valve
-- readings) vary in count (up to 3 device groups per the source form) and
-- differ slightly between authorities, so they're stored as a flexible
-- `test_results` jsonb array rather than dozens of rigid columns. Everything
-- needed to drive the due-date/alert logic and the list views (device_id,
-- test_date, result, tester) stays as real columns.
create table if not exists backflow_devices (
  id uuid default uuid_generate_v4() primary key,
  customer_id uuid not null references customers(id) on delete cascade,
  site_id uuid references sites(id) on delete set null,
  water_authority text not null check (water_authority in ('yarra_valley_water', 'south_east_water', 'greater_western_water')),
  device_type text not null check (device_type in ('rpzd', 'dcv', 'scvt', 'rpda', 'dcda', 'scdat', 'pvb', 'spvb', 'avb')),
  protection_type text check (protection_type in ('containment', 'zone', 'individual')),
  make text,
  model text,
  serial_number text,
  size_mm numeric(6,1),
  location_description text,
  water_authority_property_number text,
  water_meter_number text,
  fire_service_meter_number text,
  -- Australian backflow devices are almost always tested annually; kept
  -- configurable per-device in case a specific authority/device ever
  -- requires a different cadence.
  test_frequency_months numeric(4,1) not null default 12,
  is_active boolean not null default true,
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists backflow_devices_customer_id_idx on backflow_devices(customer_id);
create index if not exists backflow_devices_site_id_idx on backflow_devices(site_id);

alter table backflow_devices enable row level security;
create policy "Authenticated can view backflow devices" on backflow_devices for select using (auth.role() = 'authenticated');
create policy "Authenticated can manage backflow devices" on backflow_devices for all using (auth.role() = 'authenticated');

create table if not exists backflow_tests (
  id uuid default uuid_generate_v4() primary key,
  device_id uuid not null references backflow_devices(id) on delete cascade,
  job_id uuid references jobs(id) on delete set null,
  test_type text not null check (test_type in ('commissioning', 'replacement', 'annual', 'repairs', 'decommission')),
  test_date date not null default current_date,
  result text not null check (result in ('pass', 'fail')),
  mains_pressure_kpa numeric(6,1),
  permission_to_turn_off_water boolean,
  strainer_installed boolean,
  strainer_cleaned boolean,
  isolating_valves_padlocked boolean,
  complies_with_as_nzs_3500_1 boolean,
  reason_for_failure text,
  repair_scheduled_date date,
  test_kit_serial_number text,
  test_kit_calibration_date date,
  tester_name text not null,
  tester_licence_number text,
  tester_phone text,
  remarks text,
  -- Array of per-device-group readings, e.g.
  -- [{ "group_label": "Main Device", "make": "...", "model": "...",
  --    "serial_number": "...", "size_mm": 25, "check_valve_1_kpa": 34,
  --    "check_valve_1_leaked": false, "check_valve_2_kpa": 36,
  --    "check_valve_2_leaked": false, "upstream_isolation_valve_tight": true,
  --    "downstream_isolation_valve_tight": true, "relief_valve_opened": true }]
  test_results jsonb not null default '[]'::jsonb,
  signature_storage_path text,
  certificate_storage_path text,
  submitted_to_water_authority_at timestamptz,
  submitted_to_email text,
  tested_by uuid references profiles(id),
  created_at timestamptz default now()
);

create index if not exists backflow_tests_device_id_idx on backflow_tests(device_id);
create index if not exists backflow_tests_test_date_idx on backflow_tests(test_date);

alter table backflow_tests enable row level security;
create policy "Authenticated can view backflow tests" on backflow_tests for select using (auth.role() = 'authenticated');
create policy "Authenticated can manage backflow tests" on backflow_tests for all using (auth.role() = 'authenticated');
