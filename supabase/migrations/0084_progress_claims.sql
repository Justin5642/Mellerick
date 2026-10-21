-- ============================================================================
-- Progress claims: where the job is up to, on the invoice.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-21, via db query --linked). Gate test
-- supabase/tests/0084_progress_claims_test.sql passed.
--
-- WHY (Justin, 21 Oct 2026, comparing a Simpro progress claim: "current
-- progress claims don't show a running total or total percentage on invoice
-- ... would be better if there was another line with a bit of a progress
-- breakdown"). A builder paying claim 2 of 4 wants to see the contract, what
-- has been claimed before, this claim and what is left.
--
-- Snapshotted on the invoice, so a sent claim never changes after the fact:
--   is_progress_claim      the invoice is a progress claim
--   claim_number           "Progress Claim No. 2"
--   claim_contract_value   contract value ex GST. Prefilled from the previous
--                          claim on the job, else the Simpro job value
--                          (purchase_orders.total_value); editable.
--   claim_previous         claimed before this one, ex GST. Prefilled from the
--                          previous claim (its previous + its subtotal), so a
--                          Simpro-era amount typed in on the first claim here
--                          carries forward; editable.
-- This claim is invoices.subtotal; to date, % and balance are derived.
--
-- On invoices, not jobs: invoices are office/admin-only (0027). Technicians
-- read jobs, and must never see a dollar figure (0028).
-- ============================================================================

alter table invoices add column if not exists is_progress_claim boolean not null default false;
alter table invoices add column if not exists claim_number integer;
alter table invoices add column if not exists claim_contract_value numeric(12,2);
alter table invoices add column if not exists claim_previous numeric(12,2);

-- All or nothing: a claim has all three figures; an ordinary invoice none.
-- The IS NOT NULLs are needed: a CHECK passes when it evaluates to NULL, so
-- "claim_contract_value > 0" alone let a claim through with no contract value
-- (the gate test's scenario 3 caught it on the first apply).
alter table invoices drop constraint if exists invoices_progress_claim_shape;
alter table invoices add constraint invoices_progress_claim_shape check (
  (not is_progress_claim and claim_number is null and claim_contract_value is null and claim_previous is null)
  or (
    is_progress_claim
    and claim_number is not null and claim_number >= 1
    and claim_contract_value is not null and claim_contract_value > 0
    and claim_previous is not null and claim_previous >= 0
  )
);

-- "The previous claim on this job" is looked up on every new claim.
create index if not exists invoices_job_progress_claims
  on invoices (job_id, claim_number desc) where is_progress_claim;

comment on column invoices.is_progress_claim is 'Progress claim (0084): the PDF shows the contract, previous claims, this claim and balance.';
comment on column invoices.claim_number is 'Progress claim number (0084).';
comment on column invoices.claim_contract_value is 'Contract value ex GST at the time of this claim (0084).';
comment on column invoices.claim_previous is 'Claimed before this claim, ex GST, including Simpro-era claims (0084).';
