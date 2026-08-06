-- =====================================================================
-- ✅ VERIFIED IN PRODUCTION — 2026-07-27, project ntdohrsujnyuqyeirqva
--
-- Rather than seeding throwaway auth.users rows into a LIVE auth table, the
-- check was run by impersonating REAL existing identities, read-only, inside a
-- transaction that rolled back. Zero writes to production.
--
--   technician 1720afed-…  |  admin 3d9d69ad-…
--
--   table                | technician | admin  <- the control proving the zeros
--   ---------------------+------------+------  are RLS, not empty tables
--   job_expenses         |     0      |   1
--   equipment_expenses   |     0      |   0    (genuinely empty; policy same shape)
--   inventory            |     0      |   0    (genuinely empty; policy same shape)
--   equipment            |     0      |  21
--   purchase_orders      |     0      |   1
--   po_cost_centers      |     0      |   7
--
--   And the tech app still works — as the technician:
--     purchase_orders_public 1 · po_cost_centers_public 7
--     variation_types_public 2 · job_variations_public 3
--
-- The seed-and-rollback script below remains valid for a NON-production
-- database (it needs to insert its own identities); it was not the method used.
-- =====================================================================

-- ========================================================================
-- RLS role-impersonation test for migration 0035
-- (companion to supabase/migrations/0035_restrict_remaining_financial_tables_to_office_admin.sql)
--
-- STATUS: PROPOSED — this has NOT been run against a live database. It is a
-- reviewable artifact for whoever owns the shared supabase/ schema (Justin).
--
-- Verifies: a technician is DENIED on every locked table, while an office user
-- is still ALLOWED. Run migration 0035 FIRST, then run this whole script in the
-- Supabase SQL editor as the default (privileged/postgres) role. Everything is
-- wrapped in one transaction that ROLLBACKs, so it seeds a throwaway technician
-- + office identity and sample $-rows, checks the policies, and leaves the
-- database untouched.
--
-- Note: `authenticated` already holds SELECT grants on these tables (that is the
-- very leak being closed), so a denied technician sees an EMPTY result (RLS
-- filters all rows -> count 0), not a permission error.
-- ========================================================================
begin;

set local client_min_messages = warning;

-- Seeding a role is an UPDATE once on_auth_user_created has run, and migration
-- 0044 refuses a role change from anyone who is not an admin or the service
-- role. service_role is a sanctioned actor in that trigger — it is how staff
-- invitation legitimately assigns a role — so the claim is set rather than the
-- control disabled. Transaction-local, and the whole script rolls back.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 1) Throwaway identities (profiles.id -> auth.users.id FK) ----------------
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'rls-test-tech@example.test'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'rls-test-office@example.test');

-- UPSERT, not INSERT. The inserts above fire on_auth_user_created
-- (0000_baseline.sql:318), which already creates a profiles row for each user —
-- so a plain insert collides on profiles_pkey. This script therefore could never
-- have completed as written, in the SQL editor or anywhere else, which is direct
-- evidence it had never actually been run before CI began executing it.
insert into profiles (id, full_name, email, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'RLS Test Tech',   'rls-test-tech@example.test',   'technician'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'RLS Test Office', 'rls-test-office@example.test', 'office')
on conflict (id) do update
  set role = excluded.role, full_name = excluded.full_name, email = excluded.email;

-- 2) One money-bearing row per locked table (seeded as the privileged role,
--    which bypasses RLS) ---------------------------------------------------
insert into inventory (name, unit_cost, unit_sell)
  values ('RLS probe part', 12.34, 56.78);

insert into equipment (name, category, purchase_cost, insurance_annual, fuel_cost_per_hour)
  values ('RLS probe truck', 'vehicle', 90000, 4200, 18.50);

insert into equipment_expenses (equipment_id, category, amount, gst_amount)
  select id, 'service', 500, 50 from equipment where name = 'RLS probe truck';

with c as (
  insert into customers (name) values ('RLS probe customer') returning id
), j as (
  insert into jobs (customer_id, title)
    select id, 'RLS probe job' from c returning id
)
insert into job_expenses (job_id, supplier_name, amount, gst_amount)
  select id, 'RLS probe supplier', 800, 80 from j;

-- 3) Impersonate the TECHNICIAN -------------------------------------------
--    RLS is only enforced for non-superuser roles, hence `set local role`.
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);

-- sanity: this session really resolves as a (non-office) technician
do $$
begin
  if is_office_or_admin(auth.uid()) then
    raise exception 'TEST SETUP BROKEN: technician resolves as office/admin';
  end if;
end $$;

-- technician must be DENIED (RLS filters every row -> count 0) everywhere
do $$
declare t text; n bigint;
begin
  foreach t in array array['job_expenses','equipment_expenses','inventory','equipment'] loop
    execute format('select count(*) from %I', t) into n;
    if n <> 0 then
      raise exception 'LEAK: technician read % row(s) from % (expected 0)', n, t;
    end if;
  end loop;
  raise notice 'PASS: technician denied on job_expenses, equipment_expenses, inventory, equipment';
end $$;

-- 4) Impersonate an OFFICE user (claims change; role stays authenticated) --
select set_config('request.jwt.claims',
  json_build_object('sub', 'bbbbbbbb-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', true);

do $$
begin
  if not is_office_or_admin(auth.uid()) then
    raise exception 'TEST SETUP BROKEN: office user does not resolve as office/admin';
  end if;
end $$;

-- office must still be ALLOWED (can see the seeded rows -> count >= 1)
do $$
declare t text; n bigint;
begin
  foreach t in array array['job_expenses','equipment_expenses','inventory','equipment'] loop
    execute format('select count(*) from %I', t) into n;
    if n < 1 then
      raise exception 'REGRESSION: office read % row(s) from % (expected >= 1)', n, t;
    end if;
  end loop;
  raise notice 'PASS: office can still read job_expenses, equipment_expenses, inventory, equipment';
end $$;

-- 5) cleanup: restore role and discard all seed data ----------------------
reset role;
rollback;
