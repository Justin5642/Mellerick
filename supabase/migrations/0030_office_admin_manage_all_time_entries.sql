-- =============================================
-- OFFICE/ADMIN CAN MANAGE TIME ENTRIES FOR ANY STAFF MEMBER
-- Run this once in the Supabase SQL editor.
--
-- The app now lets an admin build out a job after the fact and log the hours
-- against the technician who actually did the work (job-time.tsx ->
-- time-entry-edit-dialog.tsx "Staff member" picker). That inserts/updates a
-- time_entries row whose staff_id is SOMEONE ELSE's id. Whether that is
-- already allowed depends on the existing time_entries write policy: if it
-- restricts writes to the logging user (e.g. `with check (staff_id =
-- auth.uid())`), an admin logging time on behalf of a tech would be rejected
-- by RLS. This migration adds an explicit, additive policy so office/admin
-- can insert/update/delete time_entries for ANY staff member.
--
-- Postgres RLS policies for the same command are OR-combined (permissive), so
-- adding this policy never REMOVES access anyone already had -- technicians
-- keep whatever self-service clock-in/out policy they have today; it only
-- GRANTS office/admin the ability to write rows for other people. Reuses
-- is_office_or_admin(uid) from migration 0027.
--
-- Idempotent / safe to re-run.
-- =============================================

drop policy if exists "Office/admin manage all time entries" on time_entries;
create policy "Office/admin manage all time entries" on time_entries for all
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));
