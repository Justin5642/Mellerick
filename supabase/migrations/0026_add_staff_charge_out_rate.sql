-- =============================================
-- PER-EMPLOYEE CHARGE-OUT RATE
-- Run this once in the Supabase SQL editor.
--
-- Purpose: labour billing (migration 0024) bills every "qualified"
-- tradesperson at one flat company-wide rate (billing_rate_config.
-- qualified_base_rate), regardless of who's actually on the tools, and
-- bills "apprentice" staff at their own loaded cost rate + a margin. The
-- business wants to set an explicit $/hr charge-out rate per employee
-- instead (e.g. a senior tradesperson bills out higher than a newer one) --
-- this adds an optional per-staff rate that, when set, overrides both of
-- those calculations for that person's ordinary hours. The existing
-- time-and-a-half/double-time multipliers from billing_rate_config still
-- stack on top of it exactly as before (see lib/labour-billing.ts's
-- computeLabourCharge and app/api/time-entries/[id]/sync-billing/route.ts).
-- =============================================

alter table staff_cost_profiles add column if not exists charge_out_rate numeric(10,2);

comment on column staff_cost_profiles.charge_out_rate is
  'Optional per-employee override for the ordinary-hours billing rate ($/hr) charged to customers for this person''s work -- takes priority over billing_rate_config.qualified_base_rate (qualified staff) and over loaded-cost-rate + apprentice_margin_pct (apprentice staff) when set. null (default) = fall back to the existing company-wide/loaded-cost calculation. Overtime multipliers (time_and_half_multiplier/double_time_multiplier) still stack on top of whichever base rate applies. Admin-only, same RLS as the rest of staff_cost_profiles (see migration 0014).';
