-- ============================================================================
-- Table grants for 0087's cost_centres and suppliers.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-31, via SQL editor). Gate test
-- supabase/tests/0088_grant_cost_centres_and_suppliers_test.sql passed; the
-- cost centre drop-down filled straight after.
--
-- WHY (31 Oct 2026): after 0087 the cost centre drop-down on New Job and the
-- PO tab came up empty for the office. RLS was in place but the signed-in
-- role had no table privileges on the new tables (this project does not
-- expose new tables automatically), so every read came back empty. Granted explicitly here; RLS still decides which rows:
--   cost_centres  any signed-in user reads; office/admin write (0087 policies)
--   suppliers     office/admin only (0087 policy)
-- Harmless where the grants already existed.
-- ============================================================================

grant select, insert, update, delete on cost_centres to authenticated;
grant select, insert, update, delete on suppliers to authenticated;
grant all on cost_centres, suppliers to service_role;
revoke all on cost_centres, suppliers from anon;

-- Make the API pick up the tables and grants now.
notify pgrst, 'reload schema';
