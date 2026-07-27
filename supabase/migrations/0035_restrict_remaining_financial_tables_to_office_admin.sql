-- =============================================
-- RESTRICT REMAINING FINANCIAL TABLES TO OFFICE/ADMIN
-- (second $-hardening pass -- closes the leaks migration 0027 did not cover)
--
-- STATUS: PROPOSED (mobile/full-parity branch). Authored + cross-checked by an
-- automated policy-name/tech-access audit, but NOT yet applied or RLS-tested
-- against a live database (RLS can't be exercised from the mobile repo). The
-- shared `supabase/` schema is owned by Jason -- he should review this, run the
-- companion role-impersonation test in ../tests/0035_rls_role_impersonation_test.sql
-- against a real DB, and apply it. Do NOT auto-apply unreviewed. See
-- mobile/DECISIONS-FOR-AVI.md Q19/D39.
--
-- Business rule: technicians must NEVER see dollar figures -- pricing, costs
-- or margins. Every authenticated user is a Mellerick employee (single-tenant
-- app, roles admin/office/technician), so the fix is role-scoping, not
-- tenant-scoping. The ONLY technician surface is the Expo mobile app; office
-- and admin use the Next.js web app. None of the tables locked below are read
-- or written by any technician-reachable mobile route (verified per table), so
-- this does not affect the tech app -- techs only use mobile (confirmed).
--
-- Migration 0027 tightened pricing_items, quotes, quote_items, invoices,
-- invoice_items, job_items (SELECT) and google_tokens; 0034 did xero_tokens.
-- But several money-bearing tables were left on the schema-default policy
--   using (auth.role() = 'authenticated')
-- i.e. ANY logged-in user -- including a technician holding the anon key --
-- can read/write them directly via PostgREST/PowerSync regardless of what the
-- UI shows. This migration closes those remaining leaks, mirroring the 0027
-- pattern EXACTLY: drop the real blanket policy by its name, then create an
-- "Office/admin can ..." policy gated on is_office_or_admin(auth.uid()).
--
-- Reuses is_office_or_admin(uid) from migration 0027 -- do NOT redefine it.
--
-- TABLES LOCKED HERE (recommendation: lock-for-all -- pure money/bookkeeping
-- tables that no technician-reachable route touches):
--   * job_expenses        amount, gst_amount            (supplier invoices per job)
--   * equipment_expenses  amount, gst_amount            (dated spend per vehicle)
--   * inventory           unit_cost, unit_sell          (part cost/sell rates)
--   * equipment           SELECT only -- writes are already admin-only (0016).
--                         Leaks purchase_cost, insurance_annual,
--                         maintenance_annual, registration_annual,
--                         other_annual_costs, fuel_cost_per_hour and the
--                         cost-model inputs estimated_life_years,
--                         target_hours_per_year.
--
-- NOT LOCKED HERE -- DEFERRED to a rate-stripped VIEW / column-level SELECT
-- grants (separate design task). Technicians legitimately read the NON-money
-- columns of these tables, so a blanket "for all" table lock would BREAK
-- their Overview/Time tabs. Expose the operational columns to techs via a
-- view or column privileges and keep the money column office/admin-only:
--   * purchase_orders   techs read total_hours (Overview hours scoreboard) and
--                       po_number + client_reference/site_address/site_lat/
--                       site_lng (Time tab). HIDE from technicians: total_value.
--   * po_cost_centers   techs read id/name/code (Time-tab cost-centre picker)
--                       and allocated_hours (hours, operational). HIDE from
--                       technicians: allocated_amount.
--
-- No action for the other audited tables: cost_center_templates and
-- equipment_documents carry no money columns; billing_rate_config (0024) and
-- staff_cost_profiles (0014) are already admin-only.
-- =============================================

-- job_expenses -------------------------------------------------------------
drop policy if exists "Authenticated users can manage job expenses" on job_expenses;
drop policy if exists "Office/admin can manage job_expenses" on job_expenses;
create policy "Office/admin can manage job_expenses" on job_expenses for all
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

-- equipment_expenses -------------------------------------------------------
drop policy if exists "Authenticated users can manage equipment expenses" on equipment_expenses;
drop policy if exists "Office/admin can manage equipment_expenses" on equipment_expenses;
create policy "Office/admin can manage equipment_expenses" on equipment_expenses for all
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

-- inventory ----------------------------------------------------------------
drop policy if exists "Authenticated users can manage inventory" on inventory;
drop policy if exists "Office/admin can manage inventory" on inventory;
create policy "Office/admin can manage inventory" on inventory for all
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

-- equipment: tighten only the SELECT (writes stay admin-only, per 0016) -----
drop policy if exists "Authenticated can view equipment" on equipment;
drop policy if exists "Office/admin can view equipment" on equipment;
create policy "Office/admin can view equipment" on equipment for select
  using (is_office_or_admin(auth.uid()));
