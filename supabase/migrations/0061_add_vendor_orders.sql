-- =============================================
-- VENDOR ORDERS
-- Run this once in the Supabase SQL editor.
--
-- Purpose: Purchase Orders / Cost Centers (0000_baseline, 0013) only track a
-- BUDGET allocation per cost centre (po_cost_centers.allocated_amount /
-- allocated_hours) — there was no way to record an actual order placed with
-- a supplier against an already-allocated cost centre without creating a
-- brand new cost-centre line item. This mirrors Simpro's own model, where
-- VendorOrders are nested under a job's cost centre as a distinct entity
-- from the cost centre's own budget total.
--
-- A vendor order always attaches to an EXISTING po_cost_centers row (hence
-- cost_center_id not null) — raising one never creates a new cost centre.
-- job_id is denormalized from the parent PO for simpler querying/RLS-free
-- joins in the UI, same convention as job_expenses.job_id.
--
-- RLS: money-bearing, zero technician visibility, same posture job_expenses
-- ended up at after migration 0035 — written directly against
-- is_office_or_admin(auth.uid()) (defined in 0027) rather than the
-- permissive-then-restrict two-step those earlier tables went through.
-- =============================================

create table if not exists vendor_orders (
  id uuid default uuid_generate_v4() primary key,
  cost_center_id uuid references po_cost_centers(id) on delete cascade not null,
  job_id uuid references jobs(id) on delete cascade not null,
  vendor_name text not null,
  order_number text,
  description text,
  amount numeric(12,2) not null default 0,
  gst_amount numeric(12,2) not null default 0,
  status text not null default 'ordered'
    check (status in ('ordered', 'received', 'cancelled')),
  order_date date,
  notes text,
  entered_by uuid references profiles(id),
  created_at timestamptz default now()
);

create index if not exists vendor_orders_cost_center_id_idx on vendor_orders(cost_center_id);
create index if not exists vendor_orders_job_id_idx on vendor_orders(job_id);

alter table vendor_orders enable row level security;
create policy "Office/admin can manage vendor_orders" on vendor_orders for all
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

comment on table vendor_orders is
  'An actual order placed with a supplier (committed spend) against an already-allocated po_cost_centers row — distinct from the cost centre''s own budget allocation. Mirrors Simpro''s VendorOrders-nested-under-cost-centre model. Office/admin only, same as purchase_orders/po_cost_centers/job_expenses.';
comment on column vendor_orders.amount is
  'GST-exclusive, matching job_expenses.amount convention; gst_amount tracked separately.';
comment on column vendor_orders.status is
  'ordered = committed spend not yet invoiced/received. received = goods/invoice in. cancelled = order withdrawn, excluded from committed totals.';
