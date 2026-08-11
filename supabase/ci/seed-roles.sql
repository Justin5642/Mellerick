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

-- The NOT NULL / no-default set for every table below was taken from
-- information_schema against production rather than guessed, after three CI
-- rounds lost to fixing one missing column at a time.
insert into sites (id, customer_id, name, address_line1, suburb, state, postcode)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'CI Site', '1 Test Street', 'Testville', 'VIC', '3000')
on conflict (id) do nothing;

-- Assigned to the technician, so the tech legitimately reads the JOB while the
-- money hanging off it must still be refused. A fixture where the technician
-- cannot see the job at all would make every assertion pass for the wrong
-- reason.
-- status and priority are omitted so their column defaults apply: both carry
-- CHECK constraints, and a guessed literal would fail the insert for a reason
-- that has nothing to do with what this fixture is testing.
insert into jobs (id, customer_id, site_id, assigned_to, title)
values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111', 'CI Job')
on conflict (id) do nothing;

insert into invoices (id, customer_id, job_id, title, subtotal, tax_amount, total)
values ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001',
        'CI Invoice', 1000.00, 100.00, 1100.00)
on conflict (id) do nothing;

insert into quotes (id, customer_id, site_id, title, subtotal, tax_amount, total)
values ('eeeeeeee-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
        'CI Quote', 500.00, 50.00, 550.00)
on conflict (id) do nothing;

insert into pricing_items (id, name, category, pricing_type, unit_price)
values ('77777777-0000-0000-0000-000000000001', 'CI Pricing Item', 'labour', 'hourly', 180.00)
on conflict (id) do nothing;

-- job_items.total is GENERATED ALWAYS, so it is not supplied.
insert into job_items (id, job_id, name, quantity, unit_price)
values ('ffffffff-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'CI line item', 2, 150.00)
on conflict (id) do nothing;

-- time_entries is the ONE money-bearing table where a technician legitimately
-- sees their own rows, so 0045's column grant is the only thing protecting
-- rate_override. This row is theirs, WITH an override set — an empty table here
-- would make 0045's test trivially true.
--
-- AND IT WAS EMPTY, silently, until now. 0025 puts a BEFORE INSERT OR UPDATE
-- trigger on this table (enforce_rate_override_admin_only) that nulls
-- rate_override unless is_admin(auth.uid()). psql runs this seed with no JWT,
-- so auth.uid() is NULL, is_admin(NULL) is false, and the column was stripped
-- on the way in. The row existed; the value did not. The sweep asks
-- `where rate_override is not null`, got zero rows, and classified that as
-- SAFE — so the single column the whole money audit was opened on was proven
-- by nothing.
--
-- Impersonating the CI admin for this one statement is the fix, and it is the
-- same mechanism 0035's impersonation suite already uses. `set local` scopes it
-- to the transaction.
begin;
set local role authenticated;
select set_config('request.jwt.claims',
                  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);

insert into time_entries (id, job_id, staff_id, clock_in, clock_out, hours, entry_type, rate_override)
values ('99999999-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
        now() - interval '3 hours', now() - interval '1 hour', 2.0, 'work', 'time_and_half')
on conflict (id) do nothing;
commit;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);

-- Prove the value actually landed. Without this the seed can go back to
-- stripping the column and nothing would notice — which is exactly how it got
-- here.
do $$
begin
  if not exists (
    select 1 from time_entries
    where id = '99999999-0000-0000-0000-000000000001' and rate_override is not null
  ) then
    raise exception
      'SEED FAILED: time_entries.rate_override is NULL. 0025''s trigger stripped it, so the money sweep would report this table SAFE for the emptiest possible reason.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- THE TWELVE MONEY TABLES THE SWEEP COULD NOT SEE.
--
-- Everything above fills five money tables. money_boundary_sweep.sql checks
-- SEVENTEEN, and on the other twelve it was returning "readable, 0 rows" — the
-- verdict it prints for SAFE — against tables that were simply EMPTY. That is
-- the exact failure its own header warns about at :37-40, committed by the
-- fixture that feeds it, and the gate at :177-181 counts only READABLE WITH
-- DATA. So 0028 (variation pricing) and 0038 (PO money) could have been
-- reverted whole and this workflow would have stayed green.
--
-- Every remaining table therefore gets a row carrying a real figure. Values are
-- fixed literals and each row names its own id, so re-running is a no-op and
-- nothing depends on insertion order beyond the parents already seeded above.
-- ---------------------------------------------------------------------------

-- `unit` is omitted so the column default ('m³') applies. auto_approve is NOT
-- omitted even though true is the default: the job_variations row below only
-- gets priced if this type auto-approves, so the fixture states it rather than
-- inheriting it.
insert into variation_types (id, name, rate, auto_approve)
values ('44444444-0000-0000-0000-000000000001', 'CI Rock Removal', 85.00, true)
on conflict (id) do nothing;

-- rate and total_amount are deliberately NOT supplied. 0028 put a BEFORE INSERT
-- trigger on this table that discards client-supplied pricing and derives it
-- from the preset, so pointing at the auto-approve type above is the only way
-- to get a priced row — and it exercises that trigger instead of routing around
-- it. Expect rate 85.00, total_amount 340.00, status auto_approved.
insert into job_variations (id, job_id, variation_type_id, quantity, logged_by)
values ('55555555-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001',
        '44444444-0000-0000-0000-000000000001', 4, '11111111-1111-1111-1111-111111111111')
on conflict (id) do nothing;

-- The PO pair 0038 locked. Figures are chosen NOT to coincide with the ones
-- supabase/tests/0038_rls_po_money_test.sql seeds inside its own rolled-back
-- transaction: that test asserts exact values, and matching numbers here would
-- let it pass on the wrong row.
insert into purchase_orders (id, job_id, po_number, total_value, total_hours)
values ('66666666-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001',
        'CI-PO-1', 12000.00, 60)
on conflict (id) do nothing;

insert into po_cost_centers (id, po_id, name, code, allocated_amount, allocated_hours)
values ('88888888-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000001',
        'CI Stage', 'CI1', 5500.00, 24)
on conflict (id) do nothing;

-- Payroll for the CI technician — admin-only since 0014, so the technician the
-- sweep impersonates must read none of it. charge_out_rate (0026) is nullable
-- and is one of the columns the sweep names, so it is set explicitly: a NULL
-- there reads as "readable, 0 rows" for exactly the same reason an empty table
-- does.
insert into staff_cost_profiles (staff_id, hourly_rate, super_rate, workers_comp_rate,
                                 leave_loading_rate, annual_fixed_oncosts, charge_out_rate)
values ('11111111-1111-1111-1111-111111111111', 45.00, 11.50, 3.50, 17.50, 12000.00, 145.00)
on conflict (staff_id) do nothing;

-- `registration` is text, not money, but the sweep matches on column NAME, so
-- leaving it null would leave that column unproven just like an empty table.
insert into equipment (id, name, category, registration, purchase_cost, insurance_annual,
                       maintenance_annual, registration_annual, other_annual_costs, fuel_cost_per_hour)
values ('a1a1a1a1-0000-0000-0000-000000000001', 'CI Truck', 'vehicle', 'CI-000-AAA',
        90000.00, 4200.00, 3600.00, 900.00, 1200.00, 18.50)
on conflict (id) do nothing;

insert into equipment_expenses (id, equipment_id, category, supplier_name, amount, gst_amount)
values ('a2a2a2a2-0000-0000-0000-000000000001', 'a1a1a1a1-0000-0000-0000-000000000001',
        'service', 'CI Supplier', 660.00, 60.00)
on conflict (id) do nothing;

-- category is omitted so its default ('materials') applies, for the same reason
-- jobs.status is above: the CHECK constraint is not what this fixture tests.
insert into job_expenses (id, job_id, supplier_name, amount, gst_amount)
values ('b1b1b1b1-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001',
        'CI Supplier', 550.00, 50.00)
on conflict (id) do nothing;

insert into inventory (id, name, sku, unit_cost, unit_sell)
values ('c1c1c1c1-0000-0000-0000-000000000001', 'CI Part', 'CI-SKU-1', 12.50, 25.00)
on conflict (id) do nothing;

-- `total` is GENERATED ALWAYS on both line-item tables, so it is not supplied.
-- The unit prices match the parent subtotals seeded above so the fixture stays
-- internally coherent rather than merely non-empty.
insert into invoice_items (id, invoice_id, name, quantity, unit_price)
values ('d1d1d1d1-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001',
        'CI invoice line', 1, 1000.00)
on conflict (id) do nothing;

insert into quote_items (id, quote_id, name, quantity, unit_price)
values ('e1e1e1e1-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001',
        'CI quote line', 1, 500.00)
on conflict (id) do nothing;

-- billing_rate_config is the seventeenth and gets no insert here: 0024 creates
-- its singleton row (qualified_base_rate 130, call_out_fee 180) as part of the
-- migration, so CI already holds real figures for it. The guard below covers it
-- anyway, so if that ever stops being true it is loud rather than silent.

-- ---------------------------------------------------------------------------
-- THE FIXTURE CHECKS ITSELF.
--
-- A row that quietly fails to land re-creates precisely the blindness this file
-- exists to remove, and nothing downstream would say so — the sweep would call
-- the table "readable, 0 rows" and pass. So the money tables are re-derived
-- here the way money_boundary_sweep.sql derives them, and an empty one fails
-- the fixture instead of producing a green sweep.
--
-- DERIVED, NOT LISTED, and that is the whole point: a hardcoded list of
-- seventeen tables is how this gap opened. A later migration adds an eighteenth
-- money table, the list does not grow, and the sweep goes data-blind again with
-- nothing to show for it. Keep the regex character-for-character identical to
-- the sweep's — if the two drift apart, this stops guarding what the sweep
-- actually looks at, which is a worse state than not having it.
-- ---------------------------------------------------------------------------
do $$
declare
  rec record;
  n int;
  unseeded text[] := '{}';
begin
  for rec in
    select distinct c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema
     and t.table_name  = c.table_name
     and t.table_type  = 'BASE TABLE'
    where c.table_schema = 'public'
      and c.column_name ~* ('(rate|cost|price|amount|total|sell|margin|markup|hourly|salary|wage|charge'
                         || '|fee|value|balance|paid|owing|gst|deposit|discount|surcharge|levy'
                         || '|insurance|maintenance|registration|annual|subtotal|invoice_total)')
      and c.column_name !~* '(_id$|^id$|cost_center_id|rate_config_id|_number$)'
    order by c.table_name
  loop
    execute format('select count(*) from public.%I', rec.table_name) into n;
    if n = 0 then
      unseeded := unseeded || rec.table_name;
    end if;
  end loop;

  if array_length(unseeded, 1) is not null then
    raise exception
      'CI fixture: money table(s) [%] hold no rows. money_boundary_sweep.sql reports '
      'an empty table as "readable, 0 rows" — the verdict it prints for SAFE — so a '
      'policy regression on these would pass unseen. Seed them above, or the sweep '
      'is not checking them at all.', array_to_string(unseeded, ', ');
  end if;
end;
$$;
