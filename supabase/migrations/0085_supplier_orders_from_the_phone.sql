-- ============================================================================
-- Supplier purchase orders raised from the phone.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-28, via SQL editor). Gate test
-- supabase/tests/0085_supplier_orders_test.sql passed.
--
-- WHY (Justin, 28 Oct 2026): "it needs to be possible for them to raise a
-- purchase order against that cost centre to a supplier to get materials
-- delivered so that we can marry the materials up to the job and the correct
-- cost centre". Decisions: the PO goes straight to the supplier (no office
-- approval); any supplier, not just a fixed list; any technician, any job.
--
-- vendor_orders (0061) already is that record, office-entered. This adds what
-- a PO the supplier actually receives needs:
--   po_number         our number, quoted back on the docket and the invoice.
--                     Assigned by the database, so two phones can never
--                     collide. Existing rows are numbered on apply.
--   supplier_email    where it was sent; null = phoned in / at the counter.
--   delivery_address, required_by
--   emailed_at        set once the email has gone (never re-sent blindly).
--   vendor_order_items  what was ordered: description + quantity, NO PRICE.
--
-- cost_center_id stays NOT NULL (0061). Justin, 28 Oct 2026: "select the
-- cost center then raise the po so no po can be raised without a cost
-- center". A job with no cost centres yet cannot have a PO until the office
-- adds one.
--
-- RLS is unchanged: both tables stay office/admin only. Technicians raise and
-- list orders ONLY through /api/jobs/[id]/supplier-orders, which never reads
-- or returns amount / gst_amount. Neither table is in any PowerSync stream.
-- ============================================================================

create sequence if not exists vendor_order_po_seq start 1001;

alter table vendor_orders
  add column if not exists po_number text not null
    default ('PO-' || nextval('vendor_order_po_seq')::text);
alter table vendor_orders drop constraint if exists vendor_orders_po_number_key;
alter table vendor_orders add constraint vendor_orders_po_number_key unique (po_number);

alter table vendor_orders add column if not exists supplier_email text;
alter table vendor_orders add column if not exists delivery_address text;
alter table vendor_orders add column if not exists required_by date;
alter table vendor_orders add column if not exists emailed_at timestamptz;

create table if not exists vendor_order_items (
  id uuid default uuid_generate_v4() primary key,
  vendor_order_id uuid references vendor_orders(id) on delete cascade not null,
  description text not null check (length(btrim(description)) > 0),
  quantity numeric(10,2) not null default 1 check (quantity > 0),
  sort_order integer not null default 0
);

create index if not exists vendor_order_items_vendor_order_id_idx on vendor_order_items(vendor_order_id);

alter table vendor_order_items enable row level security;
drop policy if exists "Office/admin can manage vendor_order_items" on vendor_order_items;
create policy "Office/admin can manage vendor_order_items" on vendor_order_items for all
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

comment on column vendor_orders.po_number is
  'Our purchase order number (0085), e.g. PO-1001. Database-assigned and unique; the supplier quotes it on the docket and invoice.';
comment on column vendor_orders.supplier_email is
  'Address the PO was emailed to (0085). Null = no email (phoned in, or bought at the counter).';
comment on column vendor_orders.emailed_at is
  'When the PO email was accepted by the email provider (0085). Null with a supplier_email = sending failed; resend from the office.';
comment on table vendor_order_items is
  'Lines on a supplier PO (0085): description and quantity only. No price — technicians raise these. Office/admin only by RLS; technicians write through the API route.';
