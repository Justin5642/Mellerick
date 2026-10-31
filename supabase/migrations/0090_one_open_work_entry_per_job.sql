-- ============================================================================
-- One open work entry per person per job (Stage 5 of the 31 Oct 2026
-- workflow review: fix the automatic clock).
--
-- STATUS: DRAFT, not applied yet. Gate test supabase/tests/0090_one_open_work_entry_per_job_test.sql.
--
-- WHY: the phone ran two location trackers at once while the app was open
-- (foreground watcher + background task). Both saw the same arrival; the
-- background one checked the server before the foreground clock-in had
-- uploaded and inserted a second open entry. Later clock-offs then failed on
-- "two open entries" and gave up, leaving entries running. The app now stops
-- the background task while the app is open, and this index makes a second
-- open entry impossible whatever path writes it. The phone treats a clash with
-- this index as "already clocked in" (gateway and background task).
--
-- Existing duplicates must go before the index can exist. For each person and
-- job with more than one open work entry, the EARLIEST stays open (the real
-- arrival) and every later one is closed at its own clock-in (0 hours) and
-- marked edited — kept, not deleted, so the office can see what happened.
-- ============================================================================

with ranked as (
  select id,
         row_number() over (partition by staff_id, job_id order by clock_in, created_at, id) as n
  from time_entries
  where clock_out is null and entry_type = 'work'
)
update time_entries t
set clock_out = t.clock_in,
    hours = 0,
    edited_at = now()
from ranked r
where r.id = t.id and r.n > 1;

create unique index if not exists time_entries_one_open_work_entry
  on time_entries (staff_id, job_id)
  where clock_out is null and entry_type = 'work';
