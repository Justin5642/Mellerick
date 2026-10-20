-- ============================================================================
-- Auto clock-in, per person; and remembering failed site address lookups.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-20, via db query --linked). Gate test
-- supabase/tests/0082_auto_clock_and_site_geocoding_test.sql passed.
--
-- WHY (Justin, 20 Oct 2026: "auto clock on and off isn't working")
-- Auto clock-in had never fired once. Two causes in the data, neither a bug in
-- the clock logic:
--   * Most sites had no coordinates. The geofence needs site_lat/site_lng, and
--     only sites added through the web "Add site" dialog or a PO were ever
--     geocoded — none of the Simpro imports. scripts/geocode-sites.mjs fills
--     them once; /api/sites/geocode-missing (hourly) keeps new ones filled.
--     sites.geocode_attempted_at records a lookup that found nothing, so an
--     address that cannot be placed is retried weekly, not every hour.
--   * Auto clock ran only for role = technician. Owners and office staff who
--     also work on the tools were never clocked. profiles.auto_clock is a
--     per-person switch: NULL means "by role" (technicians on, others off),
--     true/false overrides. Like role and is_active (0044, 0073) it is
--     admin-only: it decides how someone's hours are recorded.
-- ============================================================================

alter table sites add column if not exists geocode_attempted_at timestamptz;
comment on column sites.geocode_attempted_at is
  'Last automatic address lookup (0082). Set whether or not it found a location; '
  'the hourly geocoder skips sites tried in the last 7 days.';

alter table profiles add column if not exists auto_clock boolean;
comment on column profiles.auto_clock is
  'Auto clock-in/out on site arrival (0082). NULL = by role (technician on, others off); '
  'true/false overrides. Admin-only.';

-- Admin-only, alongside role and is_active (0073).
create or replace function prevent_unauthorised_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     or new.is_active is distinct from old.is_active
     or new.auto_clock is distinct from old.auto_clock then
    -- service_role covers the admin-gated API routes, which authorise the
    -- caller themselves before writing. is_admin() covers an (active) admin
    -- acting directly through PostgREST with their own JWT.
    if coalesce(auth.role(), '') <> 'service_role' and not is_admin(auth.uid()) then
      raise exception
        'profiles.role, is_active and auto_clock are administrator-only'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

do $$
begin
  if position('auto_clock' in pg_get_functiondef('public.prevent_unauthorised_role_change'::regproc)) = 0 then
    raise exception 'ASSERTION FAILED: auto_clock is not admin-only';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'sites' and column_name = 'geocode_attempted_at') then
    raise exception 'ASSERTION FAILED: sites.geocode_attempted_at missing';
  end if;
end;
$$;
