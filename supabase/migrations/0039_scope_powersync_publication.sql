-- =============================================
-- SCOPE THE POWERSYNC PUBLICATION — stop replicating secrets to a third party
--
-- FOUND: the `powersync` publication was created FOR ALL TABLES (68 tables).
-- The sync RULES control what reaches a device; the PUBLICATION controls what
-- streams into PowerSync's own cloud service. So as configured, the moment a
-- PowerSync instance connects it would ingest a replica of EVERYTHING —
-- including:
--     xero_tokens          live Xero OAuth access + refresh tokens
--     google_tokens        live Google Calendar OAuth tokens
--     staff_cost_profiles  payroll: wages, on-costs, charge-out rates
--     billing_rate_config  payroll/billing configuration
--     staff_leave          staff leave records
--     device_tokens        push tokens
-- None of those are referenced by any sync rule, so nothing is lost by
-- excluding them — and OAuth tokens in particular should never leave the
-- database.
--
-- SAFE MOMENT: `select count(*) from pg_replication_slots` = 0 at time of
-- writing, i.e. no PowerSync instance has ever connected and nothing is
-- consuming this publication. Re-check that before applying; if a slot IS
-- active, dropping the publication will interrupt replication and PowerSync
-- will need to re-sync.
--
-- A publication cannot be converted from FOR ALL TABLES to a table list in
-- place, so it is dropped and recreated. The 24 tables below are derived
-- mechanically from mobile/powersync/sync-rules.yaml — if you add a table to a
-- sync rule you MUST add it here too (`alter publication powersync add table
-- <t>;`) or it will silently never sync.
-- =============================================

drop publication if exists powersync;

create publication powersync for table
  -- reference data (global_reference bucket)
  profiles,
  customers,
  sites,
  variation_types,
  -- technician's assigned-job bucket
  jobs,
  job_photos,
  job_notes,
  job_variations,
  time_entries,
  -- office/admin business set
  job_items,
  job_expenses,
  invoices,
  invoice_items,
  quotes,
  quote_items,
  pricing_items,
  inventory,
  equipment,
  equipment_expenses,
  equipment_usage_log,
  purchase_orders,
  po_cost_centers,
  backflow_devices,
  backflow_tests;

comment on publication powersync is
  'Scoped to the 24 tables referenced by mobile/powersync/sync-rules.yaml. Deliberately EXCLUDES xero_tokens, google_tokens, staff_cost_profiles, billing_rate_config, staff_leave and device_tokens so secrets and payroll never replicate into PowerSync''s cloud service. Keep in sync with sync-rules.yaml.';
