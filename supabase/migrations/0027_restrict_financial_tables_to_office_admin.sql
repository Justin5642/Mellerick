-- =============================================
-- RESTRICT FINANCIAL DATA TO OFFICE/ADMIN (hide $ figures from technicians)
-- Run this once in the Supabase SQL editor.
--
-- Business rule: technicians must never see dollar figures -- pricing,
-- quotes, invoices, or the per-line labour/material charges on a job. The
-- only numbers a tech sees are their own time vs. the time allocated. Every
-- authenticated user is a Mellerick employee (single-tenant app, roles
-- admin/office/technician), so the fix is role-scoping, not tenant-scoping.
--
-- Until now these tables carried the schema.sql default policy
-- `using (auth.role() = 'authenticated')`, i.e. ANY logged-in user -- incl.
-- a technician -- could read/write them directly via the API (they hold the
-- anon key), regardless of what the UI shows. This locks them to office/
-- admin. The mobile (technician) app reads none of these tables, so this
-- does not affect the tech app; techs only use mobile (confirmed).
--
-- job_items is a special case: migration 0024 already made its WRITES
-- admin-only but left a blanket-authenticated SELECT policy in place, which
-- is exactly the leak (unit_price per line). We tighten only the SELECT here
-- and leave the admin-only write policy from 0024 untouched.
-- =============================================

-- Security-definer role helper, mirroring is_admin() from migration 0010 --
-- runs as owner (BYPASSRLS) so the internal profiles lookup does not
-- re-trigger RLS/recurse. 'office' and 'admin' are the two non-field roles.
create or replace function is_office_or_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from profiles where id = uid and role in ('admin', 'office'));
$$;

-- pricing_items ------------------------------------------------------------
drop policy if exists "Authenticated users can manage pricing" on pricing_items;
drop policy if exists "Office/admin can manage pricing" on pricing_items;
create policy "Office/admin can manage pricing" on pricing_items for all
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

-- quotes -------------------------------------------------------------------
drop policy if exists "Authenticated users can manage quotes" on quotes;
drop policy if exists "Office/admin can manage quotes" on quotes;
create policy "Office/admin can manage quotes" on quotes for all
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

-- quote_items --------------------------------------------------------------
drop policy if exists "Authenticated users can manage quote items" on quote_items;
drop policy if exists "Office/admin can manage quote items" on quote_items;
create policy "Office/admin can manage quote items" on quote_items for all
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

-- invoices -----------------------------------------------------------------
drop policy if exists "Authenticated users can manage invoices" on invoices;
drop policy if exists "Office/admin can manage invoices" on invoices;
create policy "Office/admin can manage invoices" on invoices for all
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

-- invoice_items ------------------------------------------------------------
drop policy if exists "Authenticated users can manage invoice items" on invoice_items;
drop policy if exists "Office/admin can manage invoice items" on invoice_items;
create policy "Office/admin can manage invoice items" on invoice_items for all
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

-- job_items: tighten only the SELECT (writes stay admin-only, per 0024) -----
drop policy if exists "Authenticated users can view job items" on job_items;
drop policy if exists "Office/admin can view job items" on job_items;
create policy "Office/admin can view job items" on job_items for select
  using (is_office_or_admin(auth.uid()));

-- google_tokens: business-wide OAuth tokens, only ever touched by the web
-- settings page / OAuth flow (office/admin) or the service-role cron -------
drop policy if exists "Authenticated users can manage google tokens" on google_tokens;
drop policy if exists "Office/admin can manage google tokens" on google_tokens;
create policy "Office/admin can manage google tokens" on google_tokens for all
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));
