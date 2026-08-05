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
-- HOW THE ROLES GET SET. Migration 0044 installs a BEFORE UPDATE trigger on
-- profiles that refuses a role change from anyone who is not an admin or the
-- service role. That control is the point of the database under test, so the
-- fixture must not disable it.
--
-- It does not need to. `service_role` is an explicitly sanctioned actor in that
-- trigger — it is how staff invitation legitimately assigns a role — so this
-- seeds under service-role claims rather than switching the trigger off. The
-- control stays armed and is exercised by the seed itself: if 0044 ever stops
-- recognising the service role, this file fails.
--
-- (An earlier version suspended on_auth_user_created instead. That cannot work:
-- psql connects as a role that does not own auth.users, so the ALTER is refused
-- with "must be owner of table users".)
-- ============================================================================

-- on_auth_user_created (0000_baseline.sql:318) creates a profile row from signup
-- metadata; 0044 hardened it so the role is NOT taken from client-supplied
-- metadata. So each profile arrives with the default role and the role below is
-- applied by UPDATE, under service-role claims.
select set_config('request.jwt.claims', '{"role":"service_role"}', false);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ci-tech@test.local',   crypt('ci-password-1', gen_salt('bf')), now(), now(), now()),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ci-office@test.local', crypt('ci-password-2', gen_salt('bf')), now(), now(), now()),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ci-admin@test.local',  crypt('ci-password-3', gen_salt('bf')), now(), now(), now())
on conflict (id) do nothing;

-- Upsert rather than insert: on_auth_user_created has already created these
-- rows. `do update` is what actually assigns the role, and it is exactly the
-- path 0044 governs — which is why the service-role claim above is required and
-- not merely convenient.
insert into profiles (id, full_name, email, role, is_active)
values
  ('11111111-1111-1111-1111-111111111111', 'CI Technician', 'ci-tech@test.local',   'technician', true),
  ('22222222-2222-2222-2222-222222222222', 'CI Office',     'ci-office@test.local', 'office',     true),
  ('33333333-3333-3333-3333-333333333333', 'CI Admin',      'ci-admin@test.local',  'admin',      true)
on conflict (id) do update
  set role = excluded.role,
      full_name = excluded.full_name,
      is_active = true;

-- Prove the fixture is what the tests below assume. Without this, a silently
-- failed role assignment would leave three technicians, every "office can read"
-- positive control would fail for the wrong reason, and every "technician
-- cannot read" assertion would pass for the wrong reason.
do $$
declare
  n int;
begin
  select count(*) into n from profiles
   where id in ('11111111-1111-1111-1111-111111111111',
                '22222222-2222-2222-2222-222222222222',
                '33333333-3333-3333-3333-333333333333');
  if n <> 3 then
    raise exception 'CI fixture: expected 3 seeded profiles, found %', n;
  end if;

  select count(*) into n from profiles
   where id = '22222222-2222-2222-2222-222222222222' and role = 'office';
  if n <> 1 then
    raise exception 'CI fixture: the office role was not applied — 0044 may no longer accept service_role';
  end if;
end;
$$;

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
