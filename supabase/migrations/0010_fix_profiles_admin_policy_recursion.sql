-- =============================================
-- FIX: infinite recursion in the "Admin can manage profiles" RLS policy
--
-- The original policy checked admin status with:
--   exists (select 1 from profiles where id = auth.uid() and role = 'admin')
-- ...which queries `profiles` from within a policy ON `profiles`, so
-- Postgres re-applies the same policy to that subquery, forever. This
-- breaks EVERY query that touches `profiles` under RLS (including the
-- profiles(full_name) join used on job_photos, job_documents, job_notes,
-- time_entries, and job_variations), causing them to error out and
-- silently render as empty in the app.
--
-- Fix: move the admin check into a `security definer` function. Functions
-- run with the privileges of their owner (the migration-running role,
-- which has BYPASSRLS in Supabase), so the internal lookup against
-- `profiles` does not re-trigger RLS.
--
-- Run this once in the Supabase SQL editor.
-- =============================================

create or replace function is_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from profiles where id = uid and role = 'admin');
$$;

drop policy if exists "Admin can manage profiles" on profiles;
create policy "Admin can manage profiles" on profiles for all using (is_admin(auth.uid()));
