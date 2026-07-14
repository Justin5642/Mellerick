-- =============================================
-- COST CENTRE TEMPLATES
-- Run this once in the Supabase SQL editor.
--
-- Purpose: replicate the Simpro "cost centre" breakdown used to quote/cost
-- jobs (Below Ground Drainage / Above Ground Plumbing / Truck Cartage),
-- as reusable stage templates the office can maintain in
-- Settings > Cost Centre Templates, so a New Purchase Order doesn't need
-- its stage rows typed out from scratch every time.
--
-- Each row is one "stage" (e.g. Sewer, Rough In, Truck Cartage) tagged with
-- a group_name. Groups exist so the New PO form can offer "load one group"
-- (recreates Simpro's 3-separate-PO-per-group structure exactly) or
-- "load multiple groups at once" (merges several groups' stages into a
-- single PO) -- both are just picking which rows get appended to the
-- purchase_orders/po_cost_centers rows already used for a PO, no schema
-- change needed on that side.
--
-- Not payroll-sensitive (just standard job stage names), so this mirrors
-- variation_types: any authenticated user can manage it, same as the
-- existing "standard rates" settings pattern.
-- =============================================

create table if not exists cost_center_templates (
  id uuid default uuid_generate_v4() primary key,
  group_name text not null,
  name text not null,
  code text,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz default now()
);

alter table cost_center_templates enable row level security;
create policy "Authenticated users can manage cost center templates" on cost_center_templates for all using (auth.role() = 'authenticated');

create index if not exists cost_center_templates_group_name_idx on cost_center_templates(group_name);

comment on table cost_center_templates is
  'Reusable job cost-centre/stage names, grouped (e.g. Below Ground Drainage, Above Ground Plumbing, Truck Cartage) so a New Purchase Order can load one group (matches Simpro''s separate-PO-per-group habit) or several groups at once (merges them into a single PO). Managed in Settings > Cost Centre Templates.';
comment on column cost_center_templates.group_name is 'The stage group this row belongs to, e.g. "Below Ground Drainage". Used to offer group checkboxes on the New PO form.';
comment on column cost_center_templates.sort_order is 'Display/load order of stages within a group.';

-- Seed with the current Simpro cost centre breakdown pasted in by the
-- office (job #494 as the reference), so the templates are usable
-- immediately rather than starting empty.
insert into cost_center_templates (group_name, name, sort_order) values
  ('Below Ground Drainage', 'Sewer', 0),
  ('Below Ground Drainage', 'Stormwater', 1),
  ('Below Ground Drainage', 'Camera Inspections/Relining - Stage 1/Pipe Check', 2),
  ('Below Ground Drainage', 'Hook Up', 3),
  ('Below Ground Drainage', 'Camera Inspections/Relining - Stage 2', 4),
  ('Above Ground Plumbing', 'Rough In', 0),
  ('Above Ground Plumbing', 'Fit Off', 1),
  ('Above Ground Plumbing', 'R3 Inspection', 2),
  ('Above Ground Plumbing', 'Appliances', 3),
  ('Truck Cartage', 'Truck Cartage', 0);
