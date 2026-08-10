// GENERATED FILE — do not edit by hand.
// Regenerate: node mobile/scripts/generate-powersync-schema.mjs
//
// The device-side SQLite schema, derived from the DEPLOYED sync streams
// (mobile/powersync/sync-streams.yaml) and the live Postgres column types.
//
// SECURITY NOTE — read before assuming this file enforces the money contract:
// this schema is the UNION of every stream, so money columns DO appear here
// (e.g. job_variations.rate). That is not a leak: a technician matches only
// the rate-stripped tech streams, so those columns stay NULL on their device,
// and the office streams yield them zero rows. The guarantee is "no money
// VALUES for a technician", not "no money columns in the schema".
//
// Numeric columns are declared `real` so local reads return JS numbers,
// matching what the Supabase/PostgREST fallback returns.

import { column, Schema, Table } from '@powersync/common';

const backflow_devices = new Table({
  // id (text) is implicit
  customer_id: column.text,
  site_id: column.text,
  water_authority: column.text,
  device_type: column.text,
  protection_type: column.text,
  make: column.text,
  model: column.text,
  serial_number: column.text,
  size_mm: column.real,
  location_description: column.text,
  water_authority_property_number: column.text,
  water_meter_number: column.text,
  fire_service_meter_number: column.text,
  test_frequency_months: column.real,
  is_active: column.integer,
  notes: column.text,
  created_by: column.text,
  created_at: column.text,
  updated_at: column.text,
});

const backflow_tests = new Table({
  // id (text) is implicit
  device_id: column.text,
  job_id: column.text,
  test_type: column.text,
  test_date: column.text,
  result: column.text,
  mains_pressure_kpa: column.real,
  permission_to_turn_off_water: column.integer,
  strainer_installed: column.integer,
  strainer_cleaned: column.integer,
  isolating_valves_padlocked: column.integer,
  complies_with_as_nzs_3500_1: column.integer,
  reason_for_failure: column.text,
  repair_scheduled_date: column.text,
  test_kit_serial_number: column.text,
  test_kit_calibration_date: column.text,
  tester_name: column.text,
  tester_licence_number: column.text,
  tester_phone: column.text,
  remarks: column.text,
  test_results: column.text,
  signature_storage_path: column.text,
  certificate_storage_path: column.text,
  submitted_to_water_authority_at: column.text,
  submitted_to_email: column.text,
  tested_by: column.text,
  created_at: column.text,
});

const customers = new Table({
  // id (text) is implicit
  name: column.text,
  email: column.text,
  phone: column.text,
  mobile: column.text,
  company: column.text,
  abn: column.text,
  notes: column.text,
  is_active: column.integer,
  is_favorite: column.integer,
});

const equipment = new Table({
  // id (text) is implicit
  name: column.text,
  category: column.text,
  registration: column.text,
  is_active: column.integer,
  purchase_cost: column.real,
  purchase_date: column.text,
  estimated_life_years: column.real,
  insurance_annual: column.real,
  maintenance_annual: column.real,
  registration_annual: column.real,
  other_annual_costs: column.real,
  fuel_cost_per_hour: column.real,
  target_hours_per_year: column.real,
  notes: column.text,
  created_at: column.text,
  updated_at: column.text,
  updated_by: column.text,
  assigned_to: column.text,
});

const equipment_expenses = new Table({
  // id (text) is implicit
  equipment_id: column.text,
  category: column.text,
  supplier_name: column.text,
  description: column.text,
  invoice_number: column.text,
  expense_date: column.text,
  amount: column.real,
  gst_amount: column.real,
  receipt_storage_path: column.text,
  logged_by: column.text,
  created_at: column.text,
});

const equipment_usage_log = new Table({
  // id (text) is implicit
  equipment_id: column.text,
  job_id: column.text,
  usage_date: column.text,
  hours: column.real,
  notes: column.text,
  logged_by: column.text,
  created_at: column.text,
});

const inventory = new Table({
  // id (text) is implicit
  name: column.text,
  sku: column.text,
  description: column.text,
  category: column.text,
  unit: column.text,
  quantity_on_hand: column.real,
  reorder_level: column.real,
  unit_cost: column.real,
  unit_sell: column.real,
  supplier: column.text,
  is_active: column.integer,
  created_at: column.text,
  updated_at: column.text,
});

const invoice_items = new Table({
  // id (text) is implicit
  invoice_id: column.text,
  pricing_item_id: column.text,
  name: column.text,
  description: column.text,
  quantity: column.real,
  unit_price: column.real,
  total: column.real,
  created_at: column.text,
});

const invoices = new Table({
  // id (text) is implicit
  invoice_number: column.integer,
  customer_id: column.text,
  job_id: column.text,
  quote_id: column.text,
  title: column.text,
  status: column.text,
  subtotal: column.real,
  tax_rate: column.real,
  tax_amount: column.real,
  total: column.real,
  amount_paid: column.real,
  due_date: column.text,
  paid_at: column.text,
  notes: column.text,
  xero_invoice_id: column.text,
  created_by: column.text,
  created_at: column.text,
  updated_at: column.text,
  work_description: column.text,
});

const job_expenses = new Table({
  // id (text) is implicit
  job_id: column.text,
  supplier_name: column.text,
  category: column.text,
  description: column.text,
  invoice_number: column.text,
  invoice_date: column.text,
  amount: column.real,
  gst_amount: column.real,
  receipt_storage_path: column.text,
  entered_by: column.text,
  created_at: column.text,
  xero_bill_id: column.text,
  xero_synced_at: column.text,
  cost_center_id: column.text,
});

const job_items = new Table({
  // id (text) is implicit
  job_id: column.text,
  pricing_item_id: column.text,
  name: column.text,
  description: column.text,
  quantity: column.real,
  unit_price: column.real,
  total: column.real,
  created_at: column.text,
  source: column.text,
  staff_id: column.text,
  time_entry_id: column.text,
});

const job_notes = new Table({
  // id (text) is implicit
  job_id: column.text,
  author_id: column.text,
  content: column.text,
  created_at: column.text,
});

const job_photos = new Table({
  // id (text) is implicit
  job_id: column.text,
  uploaded_by: column.text,
  storage_path: column.text,
  caption: column.text,
  photo_type: column.text,
  created_at: column.text,
  simpro_file_id: column.text,
});

const job_variations = new Table({
  // id (text) is implicit
  job_id: column.text,
  variation_type_id: column.text,
  custom_name: column.text,
  description: column.text,
  quantity: column.real,
  unit: column.text,
  rate: column.real,
  total_amount: column.real,
  photo_storage_path: column.text,
  status: column.text,
  logged_by: column.text,
  logged_at: column.text,
  approved_by: column.text,
  approved_at: column.text,
  admin_notes: column.text,
  created_at: column.text,
  invoice_id: column.text,
  attachment_storage_path: column.text,
  attachment_file_name: column.text,
});

const jobs = new Table({
  // id (text) is implicit
  job_number: column.integer,
  customer_id: column.text,
  site_id: column.text,
  assigned_to: column.text,
  title: column.text,
  description: column.text,
  status: column.text,
  priority: column.text,
  job_type: column.text,
  scheduled_start: column.text,
  scheduled_end: column.text,
  actual_start: column.text,
  actual_end: column.text,
  google_event_id: column.text,
  notes: column.text,
  completion_notes: column.text,
  created_by: column.text,
  created_at: column.text,
  updated_at: column.text,
  admin_status: column.text,
  admin_notes: column.text,
  simpro_job_id: column.integer,
  overtime_reason: column.text,
  overtime_category: column.text,
  overtime_logged_by: column.text,
  overtime_logged_at: column.text,
  voice_report_storage_path: column.text,
  voice_report_transcript: column.text,
  voice_report_recorded_by: column.text,
  voice_report_recorded_at: column.text,
  ready_to_invoice: column.integer,
});

const po_cost_centers = new Table({
  // id (text) is implicit
  po_id: column.text,
  name: column.text,
  code: column.text,
  allocated_amount: column.real,
  allocated_hours: column.real,
  sort_order: column.integer,
  created_at: column.text,
});

const pricing_items = new Table({
  // id (text) is implicit
  name: column.text,
  description: column.text,
  category: column.text,
  pricing_type: column.text,
  unit_price: column.real,
  unit: column.text,
  is_active: column.integer,
  created_at: column.text,
  updated_at: column.text,
});

const profiles = new Table({
  // id (text) is implicit
  full_name: column.text,
  role: column.text,
  is_active: column.integer,
});

const purchase_orders = new Table({
  // id (text) is implicit
  po_number: column.text,
  job_id: column.text,
  client_reference: column.text,
  site_address: column.text,
  site_lat: column.real,
  site_lng: column.real,
  total_value: column.real,
  total_hours: column.real,
  notes: column.text,
  created_at: column.text,
  updated_at: column.text,
});

const quote_items = new Table({
  // id (text) is implicit
  quote_id: column.text,
  pricing_item_id: column.text,
  name: column.text,
  description: column.text,
  quantity: column.real,
  unit_price: column.real,
  total: column.real,
  created_at: column.text,
});

const quotes = new Table({
  // id (text) is implicit
  quote_number: column.integer,
  customer_id: column.text,
  site_id: column.text,
  job_id: column.text,
  title: column.text,
  description: column.text,
  status: column.text,
  subtotal: column.real,
  tax_rate: column.real,
  tax_amount: column.real,
  total: column.real,
  valid_until: column.text,
  notes: column.text,
  xero_quote_id: column.text,
  created_by: column.text,
  created_at: column.text,
  updated_at: column.text,
});

const sites = new Table({
  // id (text) is implicit
  customer_id: column.text,
  name: column.text,
  address_line1: column.text,
  address_line2: column.text,
  suburb: column.text,
  state: column.text,
  postcode: column.text,
  notes: column.text,
  site_lat: column.real,
  site_lng: column.real,
});

const time_entries = new Table({
  // id (text) is implicit
  job_id: column.text,
  staff_id: column.text,
  clock_in: column.text,
  clock_out: column.text,
  hours: column.real,
  notes: column.text,
  auto_clocked: column.integer,
  created_at: column.text,
  entry_type: column.text,
  travel_from_job_id: column.text,
  cost_center_id: column.text,
  edited_by: column.text,
  edited_at: column.text,
  rate_override: column.text,
});

const variation_types = new Table({
  // id (text) is implicit
  name: column.text,
  unit: column.text,
  auto_approve: column.integer,
  is_active: column.integer,
});

export const AppSchema = new Schema({
  backflow_devices,
  backflow_tests,
  customers,
  equipment,
  equipment_expenses,
  equipment_usage_log,
  inventory,
  invoice_items,
  invoices,
  job_expenses,
  job_items,
  job_notes,
  job_photos,
  job_variations,
  jobs,
  po_cost_centers,
  pricing_items,
  profiles,
  purchase_orders,
  quote_items,
  quotes,
  sites,
  time_entries,
  variation_types,
});

export type Database = (typeof AppSchema)["types"];
