-- =============================================
-- XERO INVOICE REVERSE SYNC
-- Run this once in the Supabase SQL editor.
--
-- Purpose: /api/xero/push-invoice already pushes app invoices -> Xero
-- (one-way), but nothing pulled payment status back, so an invoice paid
-- directly in Xero (bank feed reconciliation, manual entry, etc) never
-- reflected as paid here -- Reports' "Total Outstanding"/"Total Overdue"
-- figures would silently go stale for anything paid outside the app.
--
-- This adds a "last synced" timestamp on xero_tokens (mirrors
-- google_tokens.calendar_last_synced_at) so Settings can show when the
-- reverse sync last ran, same as the existing Google Calendar sync display.
-- No new column needed on invoices -- xero_invoice_id, status, amount_paid
-- and paid_at already exist and were simply unused by any write path until
-- now (see lib/xero.ts's pollXeroInvoicePayments).
-- =============================================

alter table xero_tokens add column if not exists xero_invoice_last_synced_at timestamptz;

comment on column xero_tokens.xero_invoice_last_synced_at is
  'When /api/xero/poll-invoices (cron) or the Settings "Sync now" button last pulled invoice payment status back from Xero. Null until the first sync runs.';
