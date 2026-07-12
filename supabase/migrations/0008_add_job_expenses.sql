-- =============================================
-- JOB EXPENSES / MATERIAL COSTS
-- Run this once in the Supabase SQL editor.
--
-- Purpose: implements CRM spec item "Expenses / Material Costs". Office
-- staff manually key in supplier invoices against a job (v1 — no email
-- parsing or Xero-bill pull yet, per Justin's "manual entry for now"
-- decision). Each expense can be individually pushed to Xero as a Bill
-- (ACCPAY) via /api/xero/push-expense, tagged with the job number in the
-- Bill's Reference field so it's identifiable/reportable per job in Xero
-- (Xero Projects / true cost-centre tracking is a separate paid module
-- Justin doesn't have — this is the realistic equivalent without it).
-- =============================================

create table if not exists job_expenses (
  id uuid default uuid_generate_v4() primary key,
  job_id uuid references jobs(id) on delete cascade not null,
  supplier_name text not null,
  category text not null default 'materials'
    check (category in ('materials', 'subcontractor', 'equipment_hire', 'other')),
  description text,
  invoice_number text,
  invoice_date date,
  amount numeric(10,2) not null default 0,
  gst_amount numeric(10,2) not null default 0,
  receipt_storage_path text,
  entered_by uuid references profiles(id),
  created_at timestamptz default now(),
  xero_bill_id text,
  xero_synced_at timestamptz
);

alter table job_expenses enable row level security;
create policy "Authenticated users can manage job expenses" on job_expenses for all using (auth.role() = 'authenticated');

comment on table job_expenses is
  'Supplier invoices / material costs manually entered against a job for job costing. amount is GST-exclusive to match invoice_items convention; gst_amount tracked separately. xero_bill_id/xero_synced_at are set once an office user manually pushes the expense to Xero as a Bill (this is a manual per-expense action, same pattern as the existing manual invoice push — never automatic).';

-- Office-configurable Xero account code that expense Bills get coded to.
-- Lives on xero_tokens (the existing singleton Xero-connection row) rather
-- than a new settings table, same way google_tokens grew calendar_sync_token.
alter table xero_tokens add column if not exists default_expense_account_code text;

comment on column xero_tokens.default_expense_account_code is
  'Xero chart-of-accounts code that job expense Bills are coded to when pushed (set in Settings). Pushing is blocked with a helpful error until this is set, since we can''t guess Justin''s real chart of accounts.';
