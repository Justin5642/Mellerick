-- =============================================
-- MINIMUM MARGIN TARGET
-- Run this once in the Supabase SQL editor.
--
-- Purpose: the office wants to see a job's projected margin (built-up
-- charges -- auto labour + call-out + parts + unbilled approved variations --
-- vs its true loaded cost) BEFORE raising the invoice, and be warned when it
-- falls below the business's minimum acceptable margin. This adds that
-- threshold to the existing admin-only billing config (migration 0024), so
-- it's set the same way as the other company-wide billing numbers.
--
-- Additive with a default -- safe to re-run.
-- =============================================

alter table billing_rate_config add column if not exists min_margin_pct numeric(5,2) not null default 30;

comment on column billing_rate_config.min_margin_pct is
  'Minimum acceptable gross margin (%) on a job. The Costing tab flags a job whose projected margin (built-up charges vs loaded cost) falls below this before it''s invoiced, so under-priced work is caught before billing. Admin-only, same RLS as the rest of billing_rate_config.';
