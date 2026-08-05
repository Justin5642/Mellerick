-- ============================================================================
-- CI fixture: one user per role, and MONEY IN THE MONEY TABLES.
--
-- WHY THE DATA MATTERS AS MUCH AS THE USERS. supabase/tests/money_boundary_
-- sweep.sql:37-40 says it plainly: "an empty table proves nothing here." Its
-- verdicts are:
--
--     blocked              -- the read is refused outright
--     readable, 0 rows     -- the grant exists but RLS returns nothing. SAFE.
--     READABLE WITH DATA   -- a leak
--
-- Against an empty database every money table returns "readable, 0 rows" and the
-- sweep passes while proving nothing at all. The same flaw is why
-- tests/rls/financial-tables.test.ts has always been green: it asserts
-- `toHaveLength(0)` against tables it never seeds, so it would pass with the
-- policies deleted.
--
-- So this seeds rows a technician MUST NOT see. If a policy regresses, the sweep
-- now finds real data and raises; before, it found an empty table and reported
-- "safe".
--
-- Roles are set on INSERT, deliberately. Migration 0044 installs a BEFORE UPDATE
-- trigger on profiles that refuses a role change from anyone who is not an admin
-- or the service role, so seeding by UPDATE would be blocked by the very control
-- this database exists to test. Routing around it with elevated claims would
-- weaken the fixture, so the profile rows are inserted outright and the
-- auth.users trigger that would otherwise create them is suspended.
-- ============================================================================

-- on_auth_user_created (0000_baseline.sql:318) creates a profile from signup
-- metadata. Suspended so these inserts define the roles rather than racing it —
-- and so the role never has to be applied by UPDATE.
alter table auth.users disable trigger on_auth_user_created;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ci-tech@test.local',   crypt('ci-password-1', gen_salt('bf')), now(), now(), now()),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ci-office@test.local', crypt('ci-password-2', gen_salt('bf')), now(), now(), now()),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ci-admin@test.local',  crypt('ci-password-3', gen_salt('bf')), now(), now(), now())
on conflict (id) do nothing;

insert into profiles (id, full_name, role, is_active)
values
  ('11111111-1111-1111-1111-111111111111', 'CI Technician', 'technician', true),
  ('22222222-2222-2222-2222-222222222222', 'CI Office',     'office',     true),
  ('33333333-3333-3333-3333-333333333333', 'CI Admin',      'admin',      true)
on conflict (id) do nothing;

alter table auth.users enable trigger on_auth_user_created;

-- ---------------------------------------------------------------------------
-- Business data, with dollar figures on it.
-- ---------------------------------------------------------------------------
insert into customers (id, name)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'CI Customer')
on conflict (id) do nothing;

insert into sites (id, customer_id, name, suburb, state, postcode)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'CI Site', 'Testville', 'VIC', '3000')
on conflict (id) do nothing;

-- Assigned to the technician, so the tech legitimately reads the JOB while the
-- money hanging off it must still be refused. A fixture where the technician
-- cannot see the job at all would make every assertion pass for the wrong
-- reason.
insert into jobs (id, customer_id, site_id, assigned_to, title, status, priority)
values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111', 'CI Job', 'scheduled', 'normal')
on conflict (id) do nothing;

insert into invoices (id, customer_id, job_id, title, status, subtotal, tax_amount, total)
values ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001',
        'CI Invoice', 'draft', 1000.00, 100.00, 1100.00)
on conflict (id) do nothing;

insert into quotes (id, customer_id, site_id, title, status, subtotal, tax_amount, total)
values ('eeeeeeee-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
        'CI Quote', 'draft', 500.00, 50.00, 550.00)
on conflict (id) do nothing;

insert into pricing_items (id, name, category, pricing_type, unit_price)
values ('77777777-0000-0000-0000-000000000001', 'CI Pricing Item', 'labour', 'fixed', 180.00)
on conflict (id) do nothing;

-- job_items.total is GENERATED ALWAYS, so it is not supplied.
insert into job_items (id, job_id, name, quantity, unit_price)
values ('ffffffff-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'CI line item', 2, 150.00)
on conflict (id) do nothing;

-- time_entries is the ONE money-bearing table where a technician legitimately
-- sees their own rows, so 0045's column grant is the only thing protecting
-- rate_override. This row is theirs, WITH an override set — an empty table here
-- would make 0045's test trivially true.
insert into time_entries (id, job_id, staff_id, clock_in, clock_out, hours, entry_type, rate_override)
values ('99999999-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
        now() - interval '3 hours', now() - interval '1 hour', 2.0, 'work', 'time_and_half')
on conflict (id) do nothing;
