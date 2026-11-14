-- ============================================================================
-- Each phone reports whether its automatic clock in/out can actually work.
--
-- STATUS: DRAFT — NOT APPLIED. Gate test:
-- supabase/tests/0102_auto_clock_status_test.sql
--
-- WHY (auto clock bug, 15 Nov 2026): auto clock-in hadn't fired since 10 Nov.
-- One cause was in the app (fixed in PR 143). The other is on the phones: sites
-- that WERE being watched never fired (Brodie, #2540 / #596 / #2541) and
-- clock-outs went missing (Jake #639, 10 Nov) — the signature of location set
-- to "While using" instead of "Always", Approximate location, or the app being
-- swiped closed. The phone already knows which (lib/location-tracking.tsx
-- TrackingStatus) but only showed it on the phone, so the office had no way to
-- see that a technician's hours weren't being recorded, or why.
--
-- One row per person: the latest status from whichever phone they use. The
-- phone writes its own row (when the status changes, and at most every few
-- hours otherwise); office/admin read everyone's on the Staff page.
-- ============================================================================

create table if not exists auto_clock_status (
  staff_id uuid primary key references profiles(id) on delete cascade,
  -- Tracking is running right now (foreground and/or background).
  tracking boolean not null default false,
  -- Why it isn't, when it isn't: declined | no-sites | off-hours |
  -- not-technician | signed-out | failed. Null while tracking.
  reason text check (reason is null or reason in ('declined', 'no-sites', 'off-hours', 'not-technician', 'signed-out', 'failed')),
  -- "Always" location not allowed: only works while the app is open.
  background_off boolean not null default false,
  -- Approximate location: km-level fixes, useless against a 150 m fence.
  approximate boolean not null default false,
  -- How many job sites the phone is watching.
  site_count integer not null default 0 check (site_count >= 0),
  platform text,
  app_version text,
  updated_at timestamptz not null default now()
);

comment on table auto_clock_status is
  'Latest auto clock in/out status reported by each person''s phone (0102): running or not, why, and whether location permissions stop it working. Shown to office/admin on the Staff page.';

alter table auto_clock_status enable row level security;

drop policy if exists "auto clock status: read own, office/admin read all" on auto_clock_status;
create policy "auto clock status: read own, office/admin read all"
  on auto_clock_status for select to authenticated
  using (staff_id = (select auth.uid()) or (select is_office_or_admin(auth.uid())));

drop policy if exists "auto clock status: write own" on auto_clock_status;
create policy "auto clock status: write own"
  on auto_clock_status for insert to authenticated
  with check (staff_id = (select auth.uid()));

drop policy if exists "auto clock status: update own" on auto_clock_status;
create policy "auto clock status: update own"
  on auto_clock_status for update to authenticated
  using (staff_id = (select auth.uid()))
  with check (staff_id = (select auth.uid()));

revoke all on auto_clock_status from anon, public;
grant select, insert, update on auto_clock_status to authenticated;

notify pgrst, 'reload schema';
