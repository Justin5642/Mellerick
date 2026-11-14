-- ============================================================================
-- Local copy of Xero's invoices, bills, payments and monthly profit & loss,
-- so "where should the business head" can be answered from our own database.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-11-14, via SQL editor). Gate test
-- supabase/tests/0098_xero_analytics_test.sql passed.
-- Apply (SQL editor), run supabase/tests/0098_xero_analytics_test.sql, THEN merge.
-- The sync route reports "Xero analytics tables not found" until this is applied;
-- nothing else in the app reads these tables.
--
-- WHY (Justin, 14 Nov 2026): the CRM only learns about invoices IT pushed. The
-- simPRO-era history, supplier bills, payment dates and the P&L never come back.
-- This is a read-only mirror of that data. Xero stays the record; nothing here is
-- ever written back to Xero.
--
--   xero_invoices     every sales invoice (ACCREC) and bill (ACCPAY) dated in the
--                     last 24 months. Header totals only — no line items.
--   xero_payments     every payment against them (date, amount, reference).
--   xero_pl_monthly   profit & loss per month, one row per account line.
--   xero_sync_state   one row per entity: the resume point and the last result.
--
-- MONEY: all four are office/admin only by RLS (like invoices, 0027) and are in
-- no PowerSync stream, so no technician device ever holds them. Granted
-- explicitly (the 0088 lesson: new tables are not exposed by themselves).
-- ============================================================================

create table if not exists xero_invoices (
  xero_invoice_id text primary key,
  type text not null check (type in ('ACCREC', 'ACCPAY')),
  invoice_number text,
  reference text,
  xero_contact_id text,
  contact_name text,
  status text not null,
  invoice_date date,
  due_date date,
  fully_paid_on date,
  sub_total numeric(14,2) not null default 0,
  total_tax numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  amount_due numeric(14,2) not null default 0,
  amount_paid numeric(14,2) not null default 0,
  currency_code text,
  xero_updated_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists xero_invoices_date_idx on xero_invoices (invoice_date);
create index if not exists xero_invoices_contact_idx on xero_invoices (xero_contact_id);
create index if not exists xero_invoices_type_status_idx on xero_invoices (type, status);

create table if not exists xero_payments (
  xero_payment_id text primary key,
  xero_invoice_id text,
  payment_type text,
  payment_date date,
  amount numeric(14,2) not null default 0,
  reference text,
  status text,
  account_code text,
  xero_updated_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists xero_payments_invoice_idx on xero_payments (xero_invoice_id);
create index if not exists xero_payments_date_idx on xero_payments (payment_date);

create table if not exists xero_pl_monthly (
  month date not null check (extract(day from month) = 1),
  section text not null,
  account_name text not null,
  xero_account_id text,
  amount numeric(14,2) not null default 0,
  synced_at timestamptz not null default now(),
  primary key (month, section, account_name)
);

create table if not exists xero_sync_state (
  entity text primary key check (entity in ('invoices', 'payments', 'pl_monthly')),
  cursor timestamptz,
  last_run_at timestamptz,
  last_rows integer,
  last_error text
);

alter table xero_invoices enable row level security;
alter table xero_payments enable row level security;
alter table xero_pl_monthly enable row level security;
alter table xero_sync_state enable row level security;

drop policy if exists "xero invoices: office/admin" on xero_invoices;
create policy "xero invoices: office/admin" on xero_invoices for select to authenticated
  using ((select is_office_or_admin(auth.uid())));

drop policy if exists "xero payments: office/admin" on xero_payments;
create policy "xero payments: office/admin" on xero_payments for select to authenticated
  using ((select is_office_or_admin(auth.uid())));

drop policy if exists "xero pl: office/admin" on xero_pl_monthly;
create policy "xero pl: office/admin" on xero_pl_monthly for select to authenticated
  using ((select is_office_or_admin(auth.uid())));

drop policy if exists "xero sync state: office/admin" on xero_sync_state;
create policy "xero sync state: office/admin" on xero_sync_state for select to authenticated
  using ((select is_office_or_admin(auth.uid())));

-- Read-only for people; only the service role (the sync) writes.
revoke all on xero_invoices, xero_payments, xero_pl_monthly, xero_sync_state from anon;
revoke all on xero_invoices, xero_payments, xero_pl_monthly, xero_sync_state from authenticated;
grant select on xero_invoices, xero_payments, xero_pl_monthly, xero_sync_state to authenticated;
grant select, insert, update, delete on xero_invoices, xero_payments, xero_pl_monthly, xero_sync_state to service_role;

comment on table xero_invoices is
  'Read-only mirror of Xero invoices and bills, last 24 months (0098). Written only by lib/xero-analytics.ts.';
