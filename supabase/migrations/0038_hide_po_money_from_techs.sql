-- =============================================
-- CLOSE THE LAST DOLLAR LEAK: purchase_orders + po_cost_centers
--
-- STATUS: PROPOSED (not applied). The shared `supabase/` schema and the live
-- database are Justin's — he reviews, tests and applies. Do NOT auto-apply.
-- See mobile/DECISIONS-FOR-AVI.md Q19 (the deferred half of migration 0035).
--
-- WHY THIS WAS DEFERRED FROM 0035: every other money-bearing table could simply
-- be locked to office/admin, because no technician-reachable route touched it.
-- These two are different — technicians legitimately read their NON-money
-- columns, so a blanket lock would BREAK the tech app:
--   * purchase_orders.total_hours  -> the Overview hours scoreboard
--     (mobile/components/job/hours-scoreboard.tsx)
--   * po_number + po_cost_centers.name/code -> the Time tab's "assign to stage"
--     picker (mobile/lib/data/reads/jobBilling.ts getJobCostCentres)
-- Meanwhile the MONEY columns are still readable by any authenticated user —
-- a technician holds the anon key and can query PostgREST directly, regardless
-- of what the app's UI shows:
--   * purchase_orders.total_value
--   * po_cost_centers.allocated_amount
--
-- THE FIX (same shape as 0028's rate-stripped variation views): publish
-- money-free projections for the tech app, then lock the base tables to
-- office/admin. Views run with the owner's rights (security_invoker off) so they
-- deliberately bypass the base-table RLS and expose only the non-financial
-- columns — exactly the 0028 posture. Supabase's linter will flag them as
-- security-definer views; that is intentional and is the whole point.
--
-- CLIENT CHANGES THAT MUST SHIP WITH THIS (already done on the branch):
--   * hours-scoreboard.tsx            -> purchase_orders_public
--   * getJobCostCentres (jobBilling)  -> purchase_orders_public / po_cost_centers_public
--   * getJobBilling (office-only billing screen) stays on the BASE tables — it
--     needs total_value + allocated_amount and is never reachable by a tech.
-- Apply this migration and deploy the client together, or the tech Overview and
-- Time tabs will read empty.
-- =============================================

-- 1. Money-free projections for the technician app -----------------------------

-- NOTE: `id` and the FK column `po_id` MUST be selected. PostgREST resolves
-- embedded reads between two views by tracing their columns back to the base
-- tables' foreign key — drop the FK column and
-- `purchase_orders_public?select=po_cost_centers_public(...)` stops resolving.
create or replace view purchase_orders_public as
  select id, job_id, po_number, client_reference, total_hours, created_at
  from purchase_orders;

create or replace view po_cost_centers_public as
  select id, po_id, name, code, allocated_hours, sort_order, created_at
  from po_cost_centers;

grant select on purchase_orders_public to authenticated;
grant select on po_cost_centers_public to authenticated;

comment on view purchase_orders_public is
  'Money-free projection of purchase_orders for the technician mobile app (the base table is office/admin only per migration 0038). Excludes total_value.';
comment on view po_cost_centers_public is
  'Money-free projection of po_cost_centers for the technician mobile app. Excludes allocated_amount so techs never see dollar figures.';

-- 2. Lock the base tables to office/admin --------------------------------------
-- Mirrors the 0027 / 0035 pattern exactly: drop the real blanket policy by name,
-- then re-create it gated on is_office_or_admin(auth.uid()) (defined in 0027 —
-- do NOT redefine it here).
--
-- NOTE FOR JASON: verify these two policy names against the live database before
-- applying. They are taken from 0000_baseline.sql; if a later migration renamed
-- them, a `drop policy if exists` on the wrong name silently leaves the
-- permissive policy in place and the leak OPEN (policies are OR-ed).

drop policy if exists "Authenticated users can manage purchase orders" on purchase_orders;
create policy "Office and admin can manage purchase orders" on purchase_orders
  for all
  using (is_office_or_admin(auth.uid()))
  with check (is_office_or_admin(auth.uid()));

drop policy if exists "Authenticated users can manage po cost centers" on po_cost_centers;
create policy "Office and admin can manage po cost centers" on po_cost_centers
  for all
  using (is_office_or_admin(auth.uid()))
  with check (is_office_or_admin(auth.uid()));
