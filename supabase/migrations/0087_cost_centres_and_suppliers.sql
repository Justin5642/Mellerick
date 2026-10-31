-- ============================================================================
-- Company cost centres and the supplier list (Stage 1 of the 31 Oct 2026
-- workflow review).
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-31, via SQL editor). Gate test
-- supabase/tests/0087_cost_centres_and_suppliers_test.sql passed.
--
-- WHY (Justin, 31 Oct 2026): every PO and cost line is tagged to a job and a
-- cost centre, the cost centres are a company list that can grow, and the crew
-- pick suppliers from a drop-down of our accounts.
--
-- cost_centres     the company list: Below Ground Drainage, Transport, Above
--                  Ground Plumbing, Civil. Names only, no money.
-- cost_center_templates.cost_centre_id
--                  the stages under each (Sewer, Hook Up, Rough In...). The
--                  old "Truck Cartage" group is renamed Transport; any other
--                  group the office added becomes a cost centre of its own.
-- po_cost_centers.cost_centre_id
--                  which company cost centre a job's budget line belongs to,
--                  so "Transport" can be added up across jobs. Existing lines
--                  (Simpro's messy names) are matched by keyword; anything that
--                  doesn't match stays empty for the office to set.
-- suppliers        our supplier accounts, copied from Xero contacts marked
--                  as suppliers (xero_contact_id), plus any added by hand.
-- vendor_orders.supplier_id
--                  the supplier picked from the list; null = typed in ("Other").
--
-- RLS: cost_centres readable by any signed-in user, written by office/admin.
-- suppliers office/admin only — technicians get the list through
-- /api/jobs/[id]/supplier-orders, like the orders themselves.
-- ============================================================================

create table if not exists cost_centres (
  id uuid default uuid_generate_v4() primary key,
  name text not null check (length(btrim(name)) > 0),
  code text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz default now()
);
create unique index if not exists cost_centres_name_key on cost_centres (lower(btrim(name)));

alter table cost_centres enable row level security;
drop policy if exists "cost centres: signed-in users read" on cost_centres;
create policy "cost centres: signed-in users read" on cost_centres for select
  to authenticated using (true);
drop policy if exists "cost centres: office/admin manage" on cost_centres;
create policy "cost centres: office/admin manage" on cost_centres for all
  to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

insert into cost_centres (name, sort_order)
select v.name, v.sort_order
from (values
  ('Below Ground Drainage', 1),
  ('Transport', 2),
  ('Above Ground Plumbing', 3),
  ('Civil', 4)
) as v(name, sort_order)
where not exists (select 1 from cost_centres c where lower(btrim(c.name)) = lower(v.name));

-- Stages under each cost centre.
update cost_center_templates set group_name = 'Transport' where btrim(group_name) = 'Truck Cartage';

insert into cost_centres (name, sort_order)
select distinct btrim(t.group_name), 100
from cost_center_templates t
where length(btrim(t.group_name)) > 0
  and not exists (select 1 from cost_centres c where lower(btrim(c.name)) = lower(btrim(t.group_name)));

alter table cost_center_templates
  add column if not exists cost_centre_id uuid references cost_centres(id) on delete set null;
update cost_center_templates t set cost_centre_id = c.id
from cost_centres c
where t.cost_centre_id is null and lower(btrim(c.name)) = lower(btrim(t.group_name));

-- A job's budget lines, tagged to the company list.
alter table po_cost_centers
  add column if not exists cost_centre_id uuid references cost_centres(id) on delete set null;
create index if not exists po_cost_centers_cost_centre_id_idx on po_cost_centers(cost_centre_id);

-- Keyword match for existing lines, most specific first. Unmatched lines
-- ("Water Tapping 1360") stay null.
update po_cost_centers p set cost_centre_id = c.id from cost_centres c
where p.cost_centre_id is null and c.name = 'Transport'
  and p.name ~* '(cartage|truck|transport|quarter|tipping)';
update po_cost_centers p set cost_centre_id = c.id from cost_centres c
where p.cost_centre_id is null and c.name = 'Civil'
  and p.name ~* 'civil';
update po_cost_centers p set cost_centre_id = c.id from cost_centres c
where p.cost_centre_id is null and c.name = 'Above Ground Plumbing'
  and p.name ~* '(above ground|rough|fit ?-?off|r3|appliance|hot water)';
update po_cost_centers p set cost_centre_id = c.id from cost_centres c
where p.cost_centre_id is null and c.name = 'Below Ground Drainage'
  and p.name ~* '(below ground|drain|sewer|storm|hook|camera|cctv|relin|pipe check)';

-- Supplier accounts.
create table if not exists suppliers (
  id uuid default uuid_generate_v4() primary key,
  name text not null check (length(btrim(name)) > 0),
  account_number text,
  email text,
  phone text,
  default_cost_centre_id uuid references cost_centres(id) on delete set null,
  xero_contact_id text unique,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists suppliers_name_idx on suppliers (lower(name));

alter table suppliers enable row level security;
drop policy if exists "suppliers: office/admin manage" on suppliers;
create policy "suppliers: office/admin manage" on suppliers for all
  to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

alter table vendor_orders
  add column if not exists supplier_id uuid references suppliers(id) on delete set null;
create index if not exists vendor_orders_supplier_id_idx on vendor_orders(supplier_id);

comment on table cost_centres is
  'Company-wide cost centres (0087): Below Ground Drainage, Transport, Above Ground Plumbing, Civil, and any the office adds. Stages sit under them in cost_center_templates.';
comment on column po_cost_centers.cost_centre_id is
  'The company cost centre this job budget line belongs to (0087). Null = not yet set by the office.';
comment on table suppliers is
  'Supplier accounts (0087), copied from Xero contacts marked as suppliers and kept in step nightly; Xero owns name, account number and active. Office/admin only by RLS; technicians read the list through /api/jobs/[id]/supplier-orders.';
comment on column vendor_orders.supplier_id is
  'Supplier picked from the list (0087). Null = typed in by the crew ("Other"); vendor_name always holds the name.';
