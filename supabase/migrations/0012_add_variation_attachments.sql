-- =============================================
-- VARIATION ATTACHMENTS (PDF / DOCUMENT)
-- Run this once in the Supabase SQL editor.
--
-- Purpose: `photo_storage_path` only ever gets set by the mobile app's
-- camera capture (a .jpg in the job-photos bucket) -- there was nowhere
-- to attach an existing file (e.g. a supplier quote/invoice PDF backing
-- a variation) directly to the variation itself. This adds a second,
-- generic attachment path (stored in the job-documents bucket, which
-- already accepts pdf/doc/image types) so a variation can carry its own
-- supporting document instead of relying on the job-level Documents tab.
-- =============================================

alter table job_variations
  add column if not exists attachment_storage_path text,
  add column if not exists attachment_file_name text;

comment on column job_variations.attachment_storage_path is
  'Path in the job-documents storage bucket for a supporting file (e.g. supplier quote/invoice PDF) attached directly to this variation. Distinct from photo_storage_path, which is a camera photo captured on mobile and stored in the job-photos bucket.';

comment on column job_variations.attachment_file_name is
  'Original filename of the attachment, shown in the UI (storage_path itself is a generated key).';
