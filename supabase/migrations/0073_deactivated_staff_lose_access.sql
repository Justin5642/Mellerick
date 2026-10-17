-- ============================================================================
-- Deactivated staff lose access, and the four "_public" views refuse anon.
--
-- STATUS: DRAFT — NOT APPLIED. Apply to production on its own, then run
-- supabase/tests/0073_deactivation_test.sql and flip this line.
--
-- 1. DEACTIVATION DID NOTHING ON THE SERVER
-- The staff screen sets profiles.is_active = false and reports "Staff member
-- deactivated". Nothing on the server read that flag: is_admin() and
-- is_office_or_admin() — which gate every money table, the token tables and
-- profiles itself — only looked at role. A deactivated office user kept every
-- office right their session carried. Only the mobile app checked the flag,
-- client-side.
--
-- Both helpers now also require is_active. coalesce(…, true) because the
-- column is nullable (baseline default true) and a NULL has always meant
-- active; treating it as inactive would lock out real people.
--
-- The web side of the same fix (same change): the staff screen now goes
-- through /api/staff/set-active, which also BANS the auth user so no new
-- session or token refresh is issued, and middleware + lib/api/guards.ts
-- refuse an inactive profile.
--
-- 2. A DEACTIVATED USER COULD REACTIVATE THEMSELVES
-- "Users can update own profile" lets anyone update their own row, and the
-- 0044 trigger only guarded `role`. PATCH profiles?id=eq.<self>
-- {"is_active":true} re-opened the mobile gate. The trigger now guards
-- is_active exactly as it guards role: service_role (the admin API route,
-- which authorises the caller itself) or an active admin.
--
-- 3. THE "_public" VIEWS WERE NEVER REVOKED FROM anon
-- 0028 and 0038 created variation_types_public, job_variations_public,
-- purchase_orders_public and po_cost_centers_public as owner-rights views (so
-- base-table RLS does not apply — that is the point of them) and granted
-- SELECT to authenticated. They never revoked it from anon/public, and this
-- project hands anon access to new public objects by default (N19; 0045 and
-- 0046 had to revoke it explicitly). Anyone holding the anon key — it ships
-- inside both apps — could read every variation, PO number and cost-centre
-- allocation without signing in. Revoking is harmless if it was never granted.
-- ============================================================================

-- 1. Helpers ----------------------------------------------------------------
create or replace function is_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from profiles
    where id = uid and role = 'admin' and coalesce(is_active, true)
  );
$$;

create or replace function is_office_or_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from profiles
    where id = uid and role in ('admin', 'office') and coalesce(is_active, true)
  );
$$;

-- 2. Trigger: role AND is_active are administrator-only -----------------------
create or replace function prevent_unauthorised_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     or new.is_active is distinct from old.is_active then
    -- service_role covers the admin-gated API routes, which authorise the
    -- caller themselves before writing. is_admin() covers an (active) admin
    -- acting directly through PostgREST with their own JWT.
    if coalesce(auth.role(), '') <> 'service_role' and not is_admin(auth.uid()) then
      raise exception
        'profiles.role and profiles.is_active are administrator-only'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- 3. Views: authenticated only -----------------------------------------------
revoke all on variation_types_public, job_variations_public,
              purchase_orders_public, po_cost_centers_public
  from anon, public;
grant select on variation_types_public, job_variations_public,
                purchase_orders_public, po_cost_centers_public
  to authenticated;

-- 4. Assert the end state ----------------------------------------------------
do $$
declare
  v text;
begin
  foreach v in array array['variation_types_public', 'job_variations_public',
                           'purchase_orders_public', 'po_cost_centers_public'] loop
    if has_table_privilege('anon', 'public.' || v, 'select') then
      raise exception 'ASSERTION FAILED: anon can still read %', v;
    end if;
    if not has_table_privilege('authenticated', 'public.' || v, 'select') then
      raise exception 'ASSERTION FAILED: authenticated lost select on %', v;
    end if;
  end loop;

  if position('is_active' in pg_get_functiondef('public.is_admin(uuid)'::regprocedure)) = 0
     or position('is_active' in pg_get_functiondef('public.is_office_or_admin(uuid)'::regprocedure)) = 0 then
    raise exception 'ASSERTION FAILED: role helpers do not check is_active';
  end if;

  if position('is_active' in pg_get_functiondef('public.prevent_unauthorised_role_change'::regproc)) = 0 then
    raise exception 'ASSERTION FAILED: trigger does not guard is_active';
  end if;
end;
$$;
