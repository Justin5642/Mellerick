-- =============================================
-- LINK JOB VARIATIONS TO INVOICES
-- Run this once in the Supabase SQL editor.
--
-- Purpose: closes a gap where an approved variation (extra billable work
-- beyond the original quote) had no link to the invoice it eventually got
-- billed on -- meaning an admin could approve a variation and then simply
-- forget to add it to the customer's invoice, with nothing in the system
-- to flag it. This adds an `invoice_id` so the app can tell "approved but
-- not yet on any invoice" apart from "already billed", and surface an
-- unbilled-variations warning until it's actually invoiced.
-- =============================================

alter table job_variations
  add column if not exists invoice_id uuid references invoices(id) on delete set null;

create index if not exists job_variations_invoice_id_idx on job_variations(invoice_id);

comment on column job_variations.invoice_id is
  'Set once this variation has been included as a line item on a customer invoice. Approved/auto_approved variations with invoice_id still null are "unbilled" and should be surfaced to the admin before the job is closed out.';
