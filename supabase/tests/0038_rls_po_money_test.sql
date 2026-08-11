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
-- RLS role-impersonation test for migration 0038
-- (companion to supabase/migrations/0038_hide_po_money_from_techs.sql)
--
-- STATUS: the property this asserts is VERIFIED in production (see the banner
-- above). This seed-and-rollback form is for NON-production databases.
--
-- Verifies BOTH halves of the fix, which is what makes 0038 different from 0035:
--   (a) a technician can no longer read the MONEY columns — the base tables now
--       filter to zero rows for them; and crucially
--   (b) the technician app still WORKS — the money-free views keep returning the
--       non-financial columns the Overview scoreboard and Time tab depend on.
-- A test that only proved (a) would happily pass while the tech app was broken.
--
-- Run migration 0038 FIRST, then run this whole script in the Supabase SQL
-- editor as the default (privileged/postgres) role. Wrapped in a transaction
-- that ROLLBACKs, so it leaves the database untouched.
--
-- Note: `authenticated` holds SELECT grants on these tables, so a denied
-- technician sees an EMPTY result (RLS filters all rows -> count 0), not an error.
-- ========================================================================
begin;

set local client_min_messages = warning;

-- Seeding a role is an UPDATE once on_auth_user_created has run, and 0044
-- refuses a role change from anyone who is not an admin or the service role.
-- service_role is sanctioned in that trigger, so the claim is set rather than
-- the control disabled. Transaction-local; the whole script rolls back.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 1) Throwaway identities -------------------------------------------------
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'rls38-tech@example.test'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'rls38-office@example.test');

-- UPSERT, not INSERT — on_auth_user_created (0000_baseline.sql:318) has already
-- created a profiles row for each user above, so a plain insert collides on
-- profiles_pkey. Same latent defect as 0035: neither script could complete as
-- written, which is direct evidence that neither had ever been run.
insert into profiles (id, full_name, email, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'RLS38 Tech',   'rls38-tech@example.test',   'technician'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'RLS38 Office', 'rls38-office@example.test', 'office')
on conflict (id) do update
  set role = excluded.role, full_name = excluded.full_name, email = excluded.email;

-- 2) Sample $-bearing PO data --------------------------------------------
insert into customers (id, name) values
  ('cccccccc-0000-0000-0000-000000000003', 'RLS38 Customer');

insert into jobs (id, customer_id, title, status)
  values ('dddddddd-0000-0000-0000-000000000004', 'cccccccc-0000-0000-0000-000000000003', 'RLS38 Job', 'pending');

insert into purchase_orders (id, job_id, po_number, total_value, total_hours)
  values ('eeeeeeee-0000-0000-0000-000000000005', 'dddddddd-0000-0000-0000-000000000004', 'PO-38', 12345.67, 40);

insert into po_cost_centers (id, po_id, name, code, allocated_amount)
  values ('ffffffff-0000-0000-0000-000000000006', 'eeeeeeee-0000-0000-0000-000000000005', 'Stage 1', 'S1', 5000.00);

-- 3) TECHNICIAN: base tables must be DENIED (this is the leak being closed) --
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';

do $$
declare po_count int; cc_count int;
begin
  select count(*) into po_count from purchase_orders;
  select count(*) into cc_count from po_cost_centers;
  if po_count <> 0 then
    raise exception 'FAIL: technician can still read purchase_orders (% rows) — total_value is LEAKING', po_count;
  end if;
  if cc_count <> 0 then
    raise exception 'FAIL: technician can still read po_cost_centers (% rows) — allocated_amount is LEAKING', cc_count;
  end if;
  raise notice 'PASS: technician denied on both PO base tables';
end $$;

-- 4) TECHNICIAN: the money-free VIEWS must still work (tech app not broken) --
do $$
declare v_po_count int; v_cc_count int; v_hours numeric; v_name text;
begin
  select count(*) into v_po_count from purchase_orders_public;
  select count(*) into v_cc_count from po_cost_centers_public;
  if v_po_count = 0 then
    raise exception 'FAIL: technician cannot read purchase_orders_public — the Overview hours scoreboard would be EMPTY';
  end if;
  if v_cc_count = 0 then
    raise exception 'FAIL: technician cannot read po_cost_centers_public — the Time tab stage picker would be EMPTY';
  end if;

  -- The exact columns the tech screens depend on must be present and correct.
  -- SCOPED BY ID, not `limit 1`. The CI fixture (supabase/ci/seed-roles.sql) now
  -- seeds its own PO into the same database, so an unordered `limit 1` reads
  -- whichever row the heap offers and this assertion becomes a coin toss —
  -- passing on a row the test never wrote.
  select total_hours into v_hours from purchase_orders_public
   where id = 'eeeeeeee-0000-0000-0000-000000000005';
  select name into v_name from po_cost_centers_public
   where id = 'ffffffff-0000-0000-0000-000000000006';
  if v_hours is distinct from 40 then
    raise exception 'FAIL: purchase_orders_public.total_hours wrong (got %)', v_hours;
  end if;
  if v_name is distinct from 'Stage 1' then
    raise exception 'FAIL: po_cost_centers_public.name wrong (got %)', v_name;
  end if;
  raise notice 'PASS: technician still reads the money-free views (hours=%, stage=%)', v_hours, v_name;
end $$;

-- 5) TECHNICIAN: the views must NOT expose the money columns at all ---------
do $$
declare leaked text;
begin
  select string_agg(table_name || '.' || column_name, ', ') into leaked
  from information_schema.columns
  where table_schema = 'public'
    and ((table_name = 'purchase_orders_public'  and column_name = 'total_value')
      or (table_name = 'po_cost_centers_public'  and column_name = 'allocated_amount'));
  if leaked is not null then
    raise exception 'FAIL: money column(s) present in a public view: %', leaked;
  end if;
  raise notice 'PASS: no money columns in either public view';
end $$;

-- 6) OFFICE: must still read the base tables (incl. the $ columns) ----------
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}';

do $$
declare v_total numeric; v_alloc numeric;
begin
  -- Scoped by id for the same reason as step 4: the fixture's own PO is in this
  -- table too, and reading an arbitrary row would assert nothing about this one.
  select total_value into v_total from purchase_orders
   where id = 'eeeeeeee-0000-0000-0000-000000000005';
  select allocated_amount into v_alloc from po_cost_centers
   where id = 'ffffffff-0000-0000-0000-000000000006';
  if v_total is distinct from 12345.67 then
    raise exception 'FAIL: office cannot read purchase_orders.total_value (got %)', v_total;
  end if;
  if v_alloc is distinct from 5000.00 then
    raise exception 'FAIL: office cannot read po_cost_centers.allocated_amount (got %)', v_alloc;
  end if;
  raise notice 'PASS: office still reads both PO base tables incl. money';
end $$;

reset role;
rollback;
