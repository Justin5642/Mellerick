-- ============================================================================
-- Limited-access accounts: see only the jobs you are on.
--
-- STATUS: DRAFT — NOT APPLIED. Paste this file into the Supabase SQL editor,
-- then supabase/tests/0110_limited_access_accounts_test.sql, and trust only
-- its final "0110 PASSED" row. Then mark the reviewer account (below), THEN
-- redeploy the PowerSync sync streams (the backflow streams now read
-- profiles.limited_access) — after this, not before. Then change this header
-- to applied and record it in the ledger:
--   insert into supabase_migrations.schema_migrations (version, name)
--   values ('0110', 'limited_access_accounts') on conflict do nothing;
--
-- After this passes (one paste; the first line lets the SQL editor through
-- the admin-only trigger for this transaction, as the gate tests do):
--   select set_config('request.jwt.claims', '{"role":"service_role"}', true);
--   update profiles set limited_access = true where lower(email) = lower('<reviewer email>');
--   select id, email, role, limited_access from profiles where limited_access;
-- (The address is deliberately not in this file: the repository is public.)
--
-- WHY (Justin, Nov 2026): Apple's App Store reviewer signs in as a technician
-- account ("App Review"). A technician may look any job up (16 Nov 2026), and
-- every device receives the backflow register — every customer and site that
-- owns an active device. That is real customers' names, phone numbers and
-- addresses on a stranger's phone. The reviewer's account must see ONLY the
-- jobs it is on (QA job #834) and their customer and site, and no backflow
-- register at all. Real technicians must be completely unaffected.
--
-- HOW. profiles.limited_access (default false) + is_limited_account(), and
-- RESTRICTIVE SELECT policies. Postgres ANDs restrictive policies onto the
-- permissive ones, so the existing permissive policies are untouched and a
-- caller whose flag is false passes every one of these at the first term —
-- `(select not is_limited_account())` is an init-plan, evaluated once per
-- statement. For a limited account:
--   jobs                         → user_can_manage_job(id)        (crew/lead)
--   customers                    → a job they can manage has that customer
--   sites                        → a job they can manage has that site
--   job_photos, job_documents,
--   job_notes, job_stage_notes   → user_can_manage_job(job_id)
--   backflow_devices,
--   backflow_tests               → nothing
--   storage.objects (job-photos, job-documents, job-audio; keys are
--     <jobId>/…)                 → user_can_manage_job(first path segment)
-- The money-free views (purchase_orders_public, po_cost_centers_public,
-- job_variations_public) run as their owner, so RLS never reaches them; they
-- are re-created with the same columns plus the same job filter.
--
-- Already scoped, left alone: job_assignments (own rows), job_bookings and
-- hire_entries (user_can_manage_job, 0107/0108), time_entries (own rows),
-- equipment_usage_log (restrictive by job, 0074), every money table
-- (office/admin). Not narrowed: profiles (staff names — the app needs crew
-- names, and the phone's `profiles` stream sends them to every device anyway),
-- cost centres, variation types, fleet tables (no customer data).
--
-- Intended for TECHNICIAN accounts. user_can_manage_job is true for any
-- office/admin, so on an office account only the backflow part would bite.
--
-- THE FLAG IS PRIVILEGED, like role, is_active and auto_clock (0044, 0073,
-- 0082): only an admin or the service role may change it.
-- handle_new_user() (0044) inserts only id/full_name/email/role, so a new
-- account always starts at the column default (false) whatever metadata the
-- client sends. profiles has table-level grants only (no column grants), so
-- the new column needs no grant of its own.
--
-- RECURSION, checked: user_can_manage_job (0059) and the two customer/site
-- helpers below are SECURITY DEFINER and read jobs/job_assignments as the
-- owner, so a restrictive policy on jobs never re-enters itself.
--
-- WRITES. A restrictive SELECT policy also applies to rows an INSERT/UPDATE
-- returns. On their own job everything works as before (notes, photos, time,
-- sign-off). A limited account creating a customer, site or backflow device
-- gets an RLS error — intended: the reviewer has nothing to create there.
-- ============================================================================

-- 1. The flag -----------------------------------------------------------------
alter table profiles add column if not exists limited_access boolean not null default false;
comment on column profiles.limited_access is
  'Limited-access account (0110): sees only the jobs it is on (and their customer, site and files), '
  'no backflow register. For the App Store review account. Admin-only, like role.';

-- 2. Admin-only, alongside role, is_active and auto_clock ------------------------
create or replace function prevent_unauthorised_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     or new.is_active is distinct from old.is_active
     or new.auto_clock is distinct from old.auto_clock
     or new.limited_access is distinct from old.limited_access then
    -- service_role covers the admin-gated API routes, which authorise the
    -- caller themselves before writing. is_admin() covers an (active) admin
    -- acting directly through PostgREST with their own JWT. Unchanged from
    -- 0082 apart from the new column: the SQL editor (no JWT) is refused too,
    -- so the update in the header claims the service role first.
    if coalesce(auth.role(), '') <> 'service_role' and not is_admin(auth.uid()) then
      raise exception
        'profiles.role, is_active, auto_clock and limited_access are administrator-only'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- 3. Helpers ---------------------------------------------------------------------
create or replace function is_limited_account()
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select coalesce((select p.limited_access from public.profiles p where p.id = auth.uid()), false);
$$;
comment on function is_limited_account() is
  'True when the caller''s profile has limited_access (0110). SECURITY DEFINER so it can be used inside '
  'policies on any table without depending on profiles'' own RLS.';

create or replace function limited_account_can_see_customer(p_customer_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1 from public.jobs j
     where j.customer_id = p_customer_id
       and public.user_can_manage_job(j.id::text)
  );
$$;

create or replace function limited_account_can_see_site(p_site_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1 from public.jobs j
     where j.site_id = p_site_id
       and public.user_can_manage_job(j.id::text)
  );
$$;

revoke execute on function is_limited_account() from public, anon;
revoke execute on function limited_account_can_see_customer(uuid) from public, anon;
revoke execute on function limited_account_can_see_site(uuid) from public, anon;
-- Policies run their functions as the caller, so authenticated must be able to.
grant execute on function is_limited_account() to authenticated, service_role;
grant execute on function limited_account_can_see_customer(uuid) to authenticated, service_role;
grant execute on function limited_account_can_see_site(uuid) to authenticated, service_role;

-- 4. Restrictive SELECT policies -----------------------------------------------------
-- Dropped by the exact names created here (this migration owns them), so a
-- re-run replaces rather than duplicates. Existing permissive policies are
-- not touched.
drop policy if exists "limited accounts: own jobs only" on jobs;
create policy "limited accounts: own jobs only" on jobs
  as restrictive for select to authenticated
  using ((select not is_limited_account()) or user_can_manage_job(id::text));

drop policy if exists "limited accounts: customers of own jobs only" on customers;
create policy "limited accounts: customers of own jobs only" on customers
  as restrictive for select to authenticated
  using ((select not is_limited_account()) or limited_account_can_see_customer(id));

drop policy if exists "limited accounts: sites of own jobs only" on sites;
create policy "limited accounts: sites of own jobs only" on sites
  as restrictive for select to authenticated
  using ((select not is_limited_account()) or limited_account_can_see_site(id));

drop policy if exists "limited accounts: own jobs only" on job_photos;
create policy "limited accounts: own jobs only" on job_photos
  as restrictive for select to authenticated
  using ((select not is_limited_account()) or user_can_manage_job(job_id::text));

drop policy if exists "limited accounts: own jobs only" on job_documents;
create policy "limited accounts: own jobs only" on job_documents
  as restrictive for select to authenticated
  using ((select not is_limited_account()) or user_can_manage_job(job_id::text));

drop policy if exists "limited accounts: own jobs only" on job_notes;
create policy "limited accounts: own jobs only" on job_notes
  as restrictive for select to authenticated
  using ((select not is_limited_account()) or user_can_manage_job(job_id::text));

drop policy if exists "limited accounts: own jobs only" on job_stage_notes;
create policy "limited accounts: own jobs only" on job_stage_notes
  as restrictive for select to authenticated
  using ((select not is_limited_account()) or user_can_manage_job(job_id::text));

drop policy if exists "limited accounts: no backflow register" on backflow_devices;
create policy "limited accounts: no backflow register" on backflow_devices
  as restrictive for select to authenticated
  using ((select not is_limited_account()));

drop policy if exists "limited accounts: no backflow register" on backflow_tests;
create policy "limited accounts: no backflow register" on backflow_tests
  as restrictive for select to authenticated
  using ((select not is_limited_account()));

-- Job files: every key in these three buckets starts with the job id
-- (job-photos <jobId>/…, job-documents <jobId>/…, job-audio
-- <jobId>/voice-report.*). Other buckets pass this policy untouched.
drop policy if exists "limited accounts: job files of own jobs only" on storage.objects;
create policy "limited accounts: job files of own jobs only" on storage.objects
  as restrictive for select to authenticated
  using (
    bucket_id not in ('job-photos', 'job-documents', 'job-audio')
    or (select not public.is_limited_account())
    or public.user_can_manage_job(split_part(name, '/', 1))
  );

-- 5. The owner-run views ------------------------------------------------------------
-- Same columns, same order (create or replace view refuses anything else), so
-- grants and PostgREST's view-to-table relationships are unchanged.
-- security_barrier keeps a caller's own filters from being evaluated before
-- this one.
create or replace view purchase_orders_public with (security_barrier = true) as
  select id, job_id, po_number, client_reference, total_hours, created_at
  from purchase_orders
  where (select not is_limited_account()) or user_can_manage_job(job_id::text);

create or replace view po_cost_centers_public with (security_barrier = true) as
  select id, po_id, name, code, allocated_hours, sort_order, created_at
  from po_cost_centers pcc
  where (select not is_limited_account())
     or exists (select 1 from purchase_orders po
                 where po.id = pcc.po_id and user_can_manage_job(po.job_id::text));

create or replace view job_variations_public with (security_barrier = true) as
  select id, job_id, variation_type_id, custom_name, description, quantity, unit,
         photo_storage_path, attachment_storage_path, attachment_file_name,
         status, logged_by, logged_at, approved_at, invoice_id, created_at
  from job_variations
  where (select not is_limited_account()) or user_can_manage_job(job_id::text);

-- 6. Assert the end state -------------------------------------------------------------
do $$
declare
  t text;
  pol text;
  expected text[][] := array[
    array['public.jobs',             'limited accounts: own jobs only'],
    array['public.customers',        'limited accounts: customers of own jobs only'],
    array['public.sites',            'limited accounts: sites of own jobs only'],
    array['public.job_photos',       'limited accounts: own jobs only'],
    array['public.job_documents',    'limited accounts: own jobs only'],
    array['public.job_notes',        'limited accounts: own jobs only'],
    array['public.job_stage_notes',  'limited accounts: own jobs only'],
    array['public.backflow_devices', 'limited accounts: no backflow register'],
    array['public.backflow_tests',   'limited accounts: no backflow register'],
    array['storage.objects',         'limited accounts: job files of own jobs only']
  ];
  i int;
  v text;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'limited_access'
       and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false'
  ) then
    raise exception 'ASSERTION FAILED: profiles.limited_access missing or not "boolean not null default false"';
  end if;

  if position('limited_access' in pg_get_functiondef('public.prevent_unauthorised_role_change'::regproc)) = 0 then
    raise exception 'ASSERTION FAILED: limited_access is not admin-only';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.profiles'::regclass
                    and tgname = 'profiles_role_is_privileged' and not tgisinternal and tgenabled <> 'D') then
    raise exception 'ASSERTION FAILED: profiles_role_is_privileged trigger missing or disabled';
  end if;

  if not (select prosecdef from pg_proc where oid = 'public.is_limited_account()'::regprocedure) then
    raise exception 'ASSERTION FAILED: is_limited_account is not SECURITY DEFINER';
  end if;
  if has_function_privilege('anon', 'public.is_limited_account()', 'execute') then
    raise exception 'ASSERTION FAILED: anon can execute is_limited_account';
  end if;
  if not has_function_privilege('authenticated', 'public.is_limited_account()', 'execute')
     or not has_function_privilege('authenticated', 'public.limited_account_can_see_customer(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.limited_account_can_see_site(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.user_can_manage_job(text)', 'execute') then
    raise exception 'ASSERTION FAILED: authenticated cannot execute a function the 0110 policies call';
  end if;

  for i in 1 .. array_length(expected, 1) loop
    t := expected[i][1];
    pol := expected[i][2];
    if not exists (
      select 1 from pg_policy p
       where p.polrelid = t::regclass and p.polname = pol
         and not p.polpermissive and p.polcmd = 'r'
         and p.polroles = array['authenticated'::regrole]::oid[]
    ) then
      raise exception 'ASSERTION FAILED: restrictive SELECT policy "%" missing on %', pol, t;
    end if;
    if not (select relrowsecurity from pg_class where oid = t::regclass) then
      raise exception 'ASSERTION FAILED: row level security is off on %', t;
    end if;
  end loop;

  foreach v in array array['purchase_orders_public', 'po_cost_centers_public', 'job_variations_public'] loop
    if position('is_limited_account' in pg_get_viewdef(('public.' || v)::regclass)) = 0 then
      raise exception 'ASSERTION FAILED: view % does not filter limited accounts', v;
    end if;
    if has_table_privilege('anon', 'public.' || v, 'select') then
      raise exception 'ASSERTION FAILED: anon can read %', v;
    end if;
    if not has_table_privilege('authenticated', 'public.' || v, 'select') then
      raise exception 'ASSERTION FAILED: authenticated lost select on %', v;
    end if;
  end loop;
end;
$$;

select '0110 applied — now run supabase/tests/0110_limited_access_accounts_test.sql' as result;
