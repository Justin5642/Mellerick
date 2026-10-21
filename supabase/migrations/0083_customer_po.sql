-- ============================================================================
-- The customer's purchase order number, on the job and on its invoices.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-21, via db query --linked). Gate test
-- supabase/tests/0083_customer_po_test.sql passed.
--
-- WHY (Justin, 21 Oct 2026: "there needs to be a point for a purchase order
-- number on an invoice, so if we get a PO number it's attached to streamline
-- the payment process"). Builders' accounts teams match and pay bills by their
-- PO number; an invoice without it is held until someone asks.
--
--   jobs.customer_po      entered when the PO arrives (usually before the
--                         work); copied onto every invoice raised from the job.
--   invoices.customer_po  printed on the PDF and the email, and first in the
--                         Xero reference. Editable per invoice — a variation
--                         can come with its own PO.
--
-- Not purchase_orders.po_number: that table is our internal cost-centre budget
-- per job ("SIMPRO-2816", scripts/backfill-simpro-cost-centers.mjs), and its
-- client_reference column was never used. Plain text, trimmed, capped at 60 so
-- it always fits in Xero's 255-character reference alongside the site.
-- ============================================================================

alter table jobs add column if not exists customer_po text;
alter table invoices add column if not exists customer_po text;

alter table jobs drop constraint if exists jobs_customer_po_len;
alter table jobs add constraint jobs_customer_po_len
  check (customer_po is null or char_length(customer_po) between 1 and 60);
alter table invoices drop constraint if exists invoices_customer_po_len;
alter table invoices add constraint invoices_customer_po_len
  check (customer_po is null or char_length(customer_po) between 1 and 60);

comment on column jobs.customer_po is
  'Customer''s purchase order number (0083). Copied onto invoices raised from this job.';
comment on column invoices.customer_po is
  'Customer''s purchase order number (0083). On the PDF, the email and the Xero reference.';
