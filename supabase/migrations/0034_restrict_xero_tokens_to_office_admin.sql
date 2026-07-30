-- =============================================
-- RESTRICT XERO TOKENS TO OFFICE/ADMIN
-- Run this once in the Supabase SQL editor (or via `supabase db push`).
--
-- SECURITY FIX. xero_tokens stores the org's Xero OAuth access/refresh tokens.
-- Unlike google_tokens (locked down in the 0027/0028 financial-hardening pass),
-- xero_tokens never had an RLS policy in the versioned SQL, and the table was
-- created out-of-band in production — so its row-level security state is
-- unverified and may be OFF, which would let any authenticated user (including
-- a technician holding the anon key) read the Xero tokens.
--
-- This migration is idempotent and safe to run against production:
--   * `enable row level security` is a no-op if already enabled, and turns it
--     ON (the fix) if it was off.
--   * the policy is dropped-if-exists then recreated, so re-runs are clean.
--
-- After this, only office/admin may read/write xero_tokens via a normal
-- session. The app's Xero routes are unaffected: the cron/push routes use the
-- service-role client (bypasses RLS), and the account-code + OAuth-callback
-- routes are already gated to office/admin (callback to admin) in code, whose
-- sessions satisfy this policy.
--
-- NOT-APPLIED / WRONG-NAME NOTE (2026-07-30): a pg_policies check against
-- production found this migration had NOT taken effect — xero_tokens still had
-- a single permissive policy named "Auth users can manage xero tokens" with
-- qual (auth.role() = 'authenticated'), i.e. ANY authenticated user (a
-- technician holding the anon key included) could read the org's Xero OAuth
-- access + refresh tokens. The out-of-band policy was named differently than
-- the two DROPs below assumed, so `drop policy if exists` was a no-op and the
-- leak survived. The DROP for the real name is added below; because policies
-- are OR-ed, missing it silently leaves the permissive policy in place.
--
-- Reuses is_office_or_admin(uid) from migration 0027.
-- =============================================

alter table xero_tokens enable row level security;

-- The permissive policy actually present in production (verified 2026-07-30) --
-- this is the DROP that actually closes the leak.
drop policy if exists "Auth users can manage xero tokens" on xero_tokens;
-- Other historical / baseline names, dropped defensively so re-runs stay clean.
drop policy if exists "Authenticated users can manage xero tokens" on xero_tokens;
drop policy if exists "Office/admin can manage xero tokens" on xero_tokens;
create policy "Office/admin can manage xero tokens" on xero_tokens for all
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));
