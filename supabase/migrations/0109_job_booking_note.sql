-- ============================================================================
-- A scheduling note on each booking, not on the job forever.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-11-16, via SQL editor; gate test passed). Was: paste this file into the Supabase SQL
-- editor, then supabase/tests/0109_job_booking_note_test.sql, and trust only
-- its final "0109 PASSED" row. Then redeploy the PowerSync sync streams
-- (tech_job_bookings / office_job_bookings now list `note`) — AFTER this, not
-- before. Then change this header to applied.
--
-- WHY (Justin, 16 Nov 2026): "When we schedule people and we have a schedule
-- note, that note needs to be just for that schedule and not carry on every
-- time the job is opened." The note typed into the Schedule dialog / phone
-- Schedule Job sheet was only ever a job_notes row (source 'schedule', 0062),
-- and the phone's Overview showed the job's LATEST such note at the top of
-- the job for as long as the job existed. Now the note is stored on the
-- booking(s) it was written for, and the banner shows only the notes of
-- bookings that are current or still to come. The job_notes row is still
-- written too, so Notes & Activity keeps the history.
--
-- No money: a free-text instruction for the technician. job_bookings has no
-- money column and still has none.
--
-- GRANTS: job_bookings has table-level privileges only (0079 grants nothing
-- column by column; 0080 grants powersync_role SELECT on the table), so a new
-- column is covered by the existing grants and needs no grant of its own. The
-- gate test asserts that authenticated can read and write it.
--
-- TRIGGERS, checked:
--   * 0096 job_bookings_refuse_closed_job compares only job_id, the window and
--     staff_id, so a note-only edit on a closed job's booking passes (it moves
--     nothing). Intentional: correcting a note is not scheduling.
--   * 0079/0080 job_bookings_derive_update re-derives the job on any real
--     change (a no-op for a note), and job_bookings_touch bumps updated_at,
--     so the calendar poll's "newer side wins" sees the edit as the app's.
--   * 0080's sync-window triggers count a note edit as activity — correct.
-- ============================================================================

alter table job_bookings add column if not exists note text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.job_bookings'::regclass and conname = 'job_bookings_note_length'
  ) then
    alter table job_bookings
      add constraint job_bookings_note_length check (note is null or char_length(note) <= 2000);
  end if;
end $$;

comment on column public.job_bookings.note is
  'The scheduling note for this booking (0109). Shown to the booked technician while the booking is current or upcoming; '
  'a copy also goes to job_notes (source schedule) for the history.';

-- End state.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'job_bookings' and column_name = 'note' and data_type = 'text'
  ) then
    raise exception '0109: job_bookings.note is missing';
  end if;
end $$;
