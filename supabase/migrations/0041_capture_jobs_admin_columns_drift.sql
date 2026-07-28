-- Captures two columns that EXIST in production but appear in no migration:
--   jobs.admin_status  text default 'pending'
--   jobs.admin_notes   text
--
-- They were added directly to the database at some point without a tracked
-- migration, so a fresh environment built from this history would lack them and
-- both apps' Approvals workflow would break there. Verified 2026-07-28 by
-- diffing information_schema against the parsed migration history:
--   IN LIVE DB, NOT IN MIGRATIONS: admin_notes, admin_status
--
-- WHY THIS MATTERS BEYOND TIDINESS: this same ambiguity is what let the
-- `ready_to_invoice` bug survive. A source comment called that column "prod
-- drift — confirmed boolean in prod", which was plausible precisely because
-- undocumented-but-real columns were known to exist here. With drift captured,
-- "not in a migration" can once again be read as "does not exist".
--
-- SAFE TO RUN ANYWHERE: `add column if not exists` is a no-op against production
-- (both columns already there) and creates them correctly in a fresh database.
-- The default matches production, confirmed via information_schema.column_default.

alter table jobs
  add column if not exists admin_status text default 'pending';

alter table jobs
  add column if not exists admin_notes text;

comment on column jobs.admin_status is
  'Office review state for a completed job: pending | approved | sent_back. Drives the Approvals queue on web and mobile.';

comment on column jobs.admin_notes is
  'Office note attached when a job is sent back to the technician for rework.';
