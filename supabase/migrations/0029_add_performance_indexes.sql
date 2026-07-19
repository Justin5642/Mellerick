-- =============================================
-- PERFORMANCE INDEXES ON FOREIGN-KEY / FILTER COLUMNS
-- Run this once in the Supabase SQL editor.
--
-- The base schema (schema.sql) and later migrations never added indexes to
-- the foreign-key columns that the app filters on constantly. Postgres does
-- NOT auto-create an index for a foreign key -- only for the PRIMARY KEY it
-- references -- so every `.eq("job_id", ...)` etc. was a sequential scan that
-- gets slower as the table grows. The worst offender today is job_photos
-- (~9.7k rows and climbing, scanned in full on every job-detail / Photos-tab
-- load). These indexes turn those scans into index lookups.
--
-- All are `if not exists` and additive -- safe to re-run, and building them
-- on the current small/medium tables takes well under a second. No data or
-- policy changes.
-- =============================================

-- job_photos: the hot one -- ~9.7k rows, filtered by job_id and ordered by
-- created_at on every job view. Composite serves both the filter and the sort.
create index if not exists job_photos_job_id_created_at_idx on job_photos (job_id, created_at desc);

-- jobs: list/dashboard/schedule/customer views filter on these -------------
create index if not exists jobs_status_idx on jobs (status);
create index if not exists jobs_customer_id_idx on jobs (customer_id);
create index if not exists jobs_site_id_idx on jobs (site_id);
create index if not exists jobs_assigned_to_idx on jobs (assigned_to);
create index if not exists jobs_scheduled_start_idx on jobs (scheduled_start);
-- Simpro reverse-sync / backfill looks jobs up by their external id
create index if not exists jobs_simpro_job_id_idx on jobs (simpro_job_id);

-- Per-job child tables (each job-detail tab loads its own) -----------------
-- job_documents is the second hot one: ~3.9k rows, filtered by job_id and
-- ordered by created_at on every job view (composite serves both).
create index if not exists job_documents_job_id_created_at_idx on job_documents (job_id, created_at desc);
create index if not exists job_notes_job_id_created_at_idx on job_notes (job_id, created_at desc);
create index if not exists job_items_job_id_idx on job_items (job_id);
create index if not exists job_variations_job_id_idx on job_variations (job_id);
create index if not exists job_expenses_job_id_idx on job_expenses (job_id);
create index if not exists purchase_orders_job_id_idx on purchase_orders (job_id);
-- po_cost_centers are embedded under purchase_orders (PostgREST joins on po_id)
create index if not exists po_cost_centers_po_id_idx on po_cost_centers (po_id);
create index if not exists time_entries_job_id_idx on time_entries (job_id);
create index if not exists time_entries_staff_id_idx on time_entries (staff_id);

-- sites: customer-detail page lists a customer's sites ---------------------
create index if not exists sites_customer_id_idx on sites (customer_id);

-- quotes / quote_items -----------------------------------------------------
create index if not exists quotes_customer_id_idx on quotes (customer_id);
create index if not exists quotes_job_id_idx on quotes (job_id);
create index if not exists quotes_status_idx on quotes (status);
create index if not exists quote_items_quote_id_idx on quote_items (quote_id);

-- invoices / invoice_items -------------------------------------------------
create index if not exists invoices_customer_id_idx on invoices (customer_id);
create index if not exists invoices_job_id_idx on invoices (job_id);
create index if not exists invoices_status_idx on invoices (status);
create index if not exists invoice_items_invoice_id_idx on invoice_items (invoice_id);
