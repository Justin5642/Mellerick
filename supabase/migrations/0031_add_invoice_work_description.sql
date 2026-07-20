-- =============================================
-- INVOICE "DESCRIPTION OF WORKS"
-- Run this once in the Supabase SQL editor.
--
-- The technician's on-site account of what they actually did lives on the
-- job (jobs.completion_notes, typed; jobs.voice_report_transcript, the
-- Whisper transcript of the completion voice report). Until now that text
-- stopped at the job and never reached the customer -- the invoice only
-- carried a title, line items, and a free-text `notes` field used for
-- payment terms.
--
-- This adds a dedicated, customer-facing "description of works" to the
-- invoice, kept separate from `notes` so the work summary and the payment
-- terms don't get conflated. The new-invoice builder pre-fills it from the
-- linked job (completion_notes, falling back to the voice transcript); the
-- office reviews/edits it on the draft before sending; the invoice PDF
-- renders it as a "Work Carried Out" block.
--
-- Additive and nullable -- safe to re-run, no backfill needed.
-- =============================================

alter table invoices add column if not exists work_description text;

comment on column invoices.work_description is
  'Customer-facing summary of the work performed, shown as "Work Carried Out" on the invoice PDF. Pre-filled from the linked job''s completion_notes / voice_report_transcript and reviewed by the office before sending. Distinct from `notes` (payment terms).';
