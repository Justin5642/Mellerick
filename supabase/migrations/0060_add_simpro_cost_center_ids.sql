-- =============================================
-- SIMPRO COST CENTER BACKFILL — reference ID columns
-- Run this once in the Supabase SQL editor before running
-- scripts/backfill-simpro-cost-centers.mjs.
--
-- Purpose: the original Simpro job migration (migrate-simpro-jobs.mjs)
-- never pulled Sections/Cost Centers from Simpro, so the 500 imported
-- jobs have no Purchase Order / cost center breakdown. These columns
-- let the backfill script be re-run safely (idempotent) by remembering
-- which Simpro job/cost-center each Supabase row came from, same
-- pattern as jobs.simpro_job_id / job_photos.simpro_file_id.
-- =============================================

alter table purchase_orders add column if not exists simpro_job_id integer;
create unique index if not exists purchase_orders_simpro_job_id_key
  on purchase_orders(simpro_job_id) where simpro_job_id is not null;

alter table po_cost_centers add column if not exists simpro_cost_center_id integer;
create unique index if not exists po_cost_centers_simpro_cost_center_id_key
  on po_cost_centers(simpro_cost_center_id) where simpro_cost_center_id is not null;
