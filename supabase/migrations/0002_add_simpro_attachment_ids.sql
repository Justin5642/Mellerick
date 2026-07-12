-- =============================================
-- SIMPRO ATTACHMENT SYNC — reference ID columns
-- Run this once in the Supabase SQL editor before running
-- scripts/sync-simpro-attachments.mjs.
--
-- Purpose: lets the attachment-sync script be re-run safely
-- (idempotent) without re-downloading/re-uploading files that
-- were already pulled from Simpro, by remembering which Simpro
-- attachment file each Supabase row came from.
-- =============================================

alter table job_photos add column if not exists simpro_file_id text;
create unique index if not exists job_photos_simpro_file_id_key
  on job_photos(simpro_file_id) where simpro_file_id is not null;

alter table job_documents add column if not exists simpro_file_id text;
create unique index if not exists job_documents_simpro_file_id_key
  on job_documents(simpro_file_id) where simpro_file_id is not null;
