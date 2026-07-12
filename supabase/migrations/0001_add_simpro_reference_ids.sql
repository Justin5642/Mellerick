-- =============================================
-- SIMPRO MIGRATION — reference ID columns
-- Run this once in the Supabase SQL editor before running
-- scripts/migrate-simpro-jobs.mjs.
--
-- Purpose: lets the migration script be re-run safely (idempotent)
-- without creating duplicate customers/sites/jobs, by remembering
-- which Simpro record each Supabase row came from.
-- =============================================

alter table customers add column if not exists simpro_customer_id integer;
alter table customers add column if not exists needs_review boolean default false;
create unique index if not exists customers_simpro_customer_id_key
  on customers(simpro_customer_id) where simpro_customer_id is not null;

alter table sites add column if not exists simpro_site_id integer;
create unique index if not exists sites_simpro_site_id_key
  on sites(simpro_site_id) where simpro_site_id is not null;

alter table jobs add column if not exists simpro_job_id integer;
create unique index if not exists jobs_simpro_job_id_key
  on jobs(simpro_job_id) where simpro_job_id is not null;

comment on column customers.needs_review is
  'Set by the Simpro migration when an individual customer could not be safely auto-matched against existing records (e.g. similar-but-not-identical names) and needs manual dedup review.';
