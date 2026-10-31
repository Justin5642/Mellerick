-- ============================================================================
-- Supplier invoices entered against their PO, and deliveries confirmed on site
-- (Stage 4 of the 31 Oct 2026 workflow review).
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-31, via SQL editor). Gate test
-- supabase/tests/0089_supplier_invoices_on_pos_test.sql passed.
--
-- WHY (Justin, 31 Oct 2026): "When a supplier invoice arrives quoting the PO
-- number, it should be easy to attach it to the right job and cost line."
-- Supplier bills are typed into Xero by hand today, so the office types each
-- one ONCE, against its PO in the app, and the app creates the Xero bill —
-- the same typing as now, and the cost lands on the job and cost centre too.
--
-- vendor_orders gains:
--   invoice_number, invoice_date   the supplier's invoice (amount/gst_amount
--                                  already exist, 0061)
--   invoice_storage_path           the invoice file, in job-documents under
--                                  '{job}/expense-receipt-po-...' so 0047's
--                                  money-file rule keeps it from technicians
--   xero_bill_id, xero_synced_at   the Xero bill made from it (one only)
--   delivered_at, delivered_by     the crew tapped Delivered on the phone
--
-- No new table, so no new grants (see 0088). RLS unchanged: office/admin
-- only; the phone marks a delivery through /api/jobs/[id]/supplier-orders.
-- ============================================================================

alter table vendor_orders add column if not exists invoice_number text;
alter table vendor_orders add column if not exists invoice_date date;
alter table vendor_orders add column if not exists invoice_storage_path text;
alter table vendor_orders add column if not exists xero_bill_id text;
alter table vendor_orders add column if not exists xero_synced_at timestamptz;
alter table vendor_orders add column if not exists delivered_at timestamptz;
alter table vendor_orders add column if not exists delivered_by uuid references profiles(id) on delete set null;

-- One Xero bill per order, ever: a second link would mean a duplicate payable.
create unique index if not exists vendor_orders_xero_bill_id_key on vendor_orders (xero_bill_id) where xero_bill_id is not null;
create index if not exists vendor_orders_uninvoiced_idx on vendor_orders (created_at) where invoice_number is null and status <> 'cancelled';

comment on column vendor_orders.invoice_number is
  'Supplier''s invoice number, entered against this PO (0089). With amount/gst_amount it is the bill pushed to Xero.';
comment on column vendor_orders.xero_bill_id is
  'Xero ACCPAY bill created from this order''s invoice (0089). Set once; a set value blocks a second push.';
comment on column vendor_orders.delivered_at is
  'When the crew marked this order delivered on the phone (0089).';
