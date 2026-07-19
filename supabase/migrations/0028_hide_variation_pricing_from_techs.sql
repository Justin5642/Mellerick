-- =============================================
-- HIDE VARIATION PRICING FROM TECHNICIANS
-- Run this once in the Supabase SQL editor.
--
-- Business rule (same as migration 0027): technicians must never see dollar
-- figures. The variation flow is the last place a rate still leaked to the
-- tech app -- variation_types.rate and job_variations.rate/total_amount were
-- readable by any authenticated user (blanket `auth.role() = 'authenticated'`
-- policies from migration 0004), and the mobile app both displayed those
-- figures and computed the line total client-side.
--
-- The new model: a tech describes the variation (extent of works + quantity)
-- and can PRESELECT a preset variation type WITHOUT seeing its rate. Pricing
-- is applied server-side -- preset rates auto-fill via the trigger below;
-- custom / non-auto-approve variations stay unpriced for the office to price
-- and approve on the web (components/job/job-variations.tsx).
--
-- Postgres RLS is row-level, not column-level, and Supabase runs every
-- logged-in user as the single `authenticated` role, so we can't hide just
-- the rate column via a policy. Instead:
--   1. lock the base tables to office/admin (they carry the $ columns),
--   2. expose rate-stripped VIEWS for the tech app to read,
--   3. a BEFORE INSERT trigger forces rate/total/status from the preset
--      server-side and ignores any client-supplied figures.
-- Reuses is_office_or_admin(uid) from migration 0027.
-- =============================================

-- variation_types: office/admin manage the catalog + rates -----------------
drop policy if exists "Authenticated users can manage variation types" on variation_types;
drop policy if exists "Office/admin can manage variation types" on variation_types;
create policy "Office/admin can manage variation types" on variation_types for all
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

-- job_variations: split the old blanket policy into granular ones ----------
-- Techs may LOG a variation (insert their own row); the trigger below forces
-- the financial columns so a tech can neither see nor set a price. Reading
-- the priced row, pricing it, approving/rejecting and deleting are all
-- office/admin only -- techs read the rate-stripped view instead.
drop policy if exists "Authenticated users can manage job variations" on job_variations;
drop policy if exists "Users can log variations" on job_variations;
drop policy if exists "Office/admin can view variations" on job_variations;
drop policy if exists "Office/admin can update variations" on job_variations;
drop policy if exists "Office/admin can delete variations" on job_variations;

create policy "Users can log variations" on job_variations for insert
  with check (logged_by = auth.uid());
create policy "Office/admin can view variations" on job_variations for select
  using (is_office_or_admin(auth.uid()));
create policy "Office/admin can update variations" on job_variations for update
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));
create policy "Office/admin can delete variations" on job_variations for delete
  using (is_office_or_admin(auth.uid()));

-- Server-side pricing: on insert, derive rate/unit/total_amount/status from
-- the selected preset and DISCARD anything the client sent. SECURITY DEFINER
-- so it can read variation_types even though that table is now office/admin
-- only. Runs for tech and office inserts alike (office prices custom ones
-- afterwards via UPDATE, which this INSERT-only trigger never touches).
create or replace function apply_variation_pricing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  vt_rate numeric(10,2);
  vt_unit text;
  vt_auto boolean;
begin
  if new.variation_type_id is not null then
    select rate, unit, auto_approve into vt_rate, vt_unit, vt_auto
      from variation_types where id = new.variation_type_id;
    new.unit := coalesce(vt_unit, new.unit);
    if vt_auto then
      -- auto-approve preset: price it instantly, server-side
      new.rate := vt_rate;
      new.total_amount := round(coalesce(new.quantity, 0) * coalesce(vt_rate, 0), 2);
      new.status := 'auto_approved';
    else
      -- preset that still needs office sign-off: leave unpriced
      new.rate := null;
      new.total_amount := null;
      new.status := 'pending_approval';
    end if;
  else
    -- custom / one-off: office prices + approves it later
    new.rate := null;
    new.total_amount := null;
    new.status := 'pending_approval';
  end if;
  return new;
end;
$$;

drop trigger if exists job_variations_apply_pricing on job_variations;
create trigger job_variations_apply_pricing
  before insert on job_variations
  for each row execute function apply_variation_pricing();

-- Rate-stripped views for the tech app. Views run with the owner's rights
-- (security_invoker off), so they bypass the office/admin base-table RLS and
-- expose every NON-financial column to any authenticated user -- matching the
-- pre-existing "all employees can see all variations" posture, minus the $.
-- (Supabase's linter flags these as security-definer views; that is
-- intentional here -- the whole point is to expose a rate-free projection.)
create or replace view variation_types_public as
  select id, name, unit, auto_approve, is_active, created_at
  from variation_types;

create or replace view job_variations_public as
  select id, job_id, variation_type_id, custom_name, description, quantity, unit,
         photo_storage_path, attachment_storage_path, attachment_file_name,
         status, logged_by, logged_at, approved_at, invoice_id, created_at
  from job_variations;

grant select on variation_types_public to authenticated;
grant select on job_variations_public to authenticated;

comment on view variation_types_public is
  'Rate-free projection of variation_types for the technician mobile app (the base table is office/admin only per migration 0028). Excludes the rate column.';
comment on view job_variations_public is
  'Financials-free projection of job_variations for the technician mobile app. Excludes rate, total_amount and admin_notes so techs never see dollar figures.';
