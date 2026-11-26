-- ============================================================================
-- QUERY PLAN CHECK — the three most common dashboard reads
--
-- HOW TO RUN
--   Supabase Dashboard -> SQL Editor -> paste this file -> Run.
--   Read-only: every statement is a SELECT under EXPLAIN. ANALYZE really runs
--   them, but nothing writes. The editor shows only the LAST statement's
--   result, so run one EXPLAIN at a time (highlight it, then Run), or use psql:
--     psql "$SUPABASE_DB_URL" -f scripts/check-query-plans.sql
--
-- WHAT TO LOOK FOR
--   "Index Scan" / "Index Only Scan" / "Bitmap Index Scan" on the named index
--   -> fine. "Seq Scan on <table>" -> read the note under that query before
--   adding anything: at this project's size (jobs ~830, job_photos ~10k,
--   time_entries a few thousand) the planner often PREFERS a seq scan because
--   the whole table is a handful of 8 kB pages. A seq scan with
--   "Buffers: shared hit=<small>" and a sub-millisecond "Execution Time" is
--   not a problem, and an index will not make it faster.
--
--   Queries 2 and 3 pick a busy staff member / job with a sub-select so the
--   file runs as-is. That sub-select shows as "InitPlan 1" and contains its
--   own Seq Scan + HashAggregate — that is the picker, NOT the query being
--   checked. Read the plan node BELOW the InitPlan. (Or replace the sub-select
--   with a real uuid in quotes.)
--
-- CAVEAT — RLS
--   The SQL editor runs as the table owner, so RLS policies are NOT applied.
--   The app runs every query as `authenticated` under RLS, which adds the
--   policy's predicates (e.g. user_can_manage_job). To see that plan, prefix a
--   query with, in the same run:
--     set local role authenticated;
--     select set_config('request.jwt.claims',
--       json_build_object('sub', '<a real profile id>', 'role', 'authenticated')::text, true);
--   (wrap in begin; … rollback; so the role change ends with the run).
--
-- INDEXES THESE SHOULD USE (already in production)
--   1. jobs_created_at_idx                      (0070)  jobs (created_at desc)
--   2. time_entries_staff_id_idx                (0029)  time_entries (staff_id)
--      time_entries_clock_in_idx                (0070)  time_entries (clock_in)
--   3. job_photos_job_id_created_at_idx         (0029)  job_photos (job_id, created_at desc)
--
-- Checked 26 Nov 2026 on a scratch Postgres 16 with the full migration chain
-- and production-sized data (830 jobs, 10,000 photos, 3,000 time entries):
-- 1 Index Scan on jobs_created_at_idx (0.09 ms); 2 Index Scan on
-- time_entries_clock_in_idx with staff_id filtered on top (1.9 ms);
-- 3 Bitmap Index Scan on job_photos_job_id_created_at_idx (25 rows). No seq
-- scan outside the pickers, so no new index is proposed.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Recent jobs, newest first (app/dashboard/page.tsx, app/dashboard/jobs/page.tsx)
--    Expect: Limit -> Index Scan using jobs_created_at_idx.
-- ---------------------------------------------------------------------------
explain (analyze, buffers)
select id, job_number, title, status, created_at
from jobs
order by created_at desc
limit 20;


-- ---------------------------------------------------------------------------
-- 2. A staff member's work time in a date range
--    (lib/fleet-rates.ts: .in("staff_id", …).eq("entry_type", "work")
--     .not("clock_out", "is", null).gte("clock_in", …)).
--    Expect: an Index / Bitmap Index Scan on time_entries_clock_in_idx or
--    time_entries_staff_id_idx (whichever the planner thinks is narrower) with
--    the other conditions as a Filter, or a Seq Scan while the table is small.
--
--    A composite index would serve this exactly:
--      create index concurrently if not exists time_entries_staff_id_clock_in_idx
--        on time_entries (staff_id, clock_in);
--    NOT proposed now, because:
--      - the two single-column indexes already narrow it (one staff member's
--        rows are a few hundred at most), and at a few thousand rows the
--        planner may rightly pick a seq scan anyway;
--      - every clock-on / clock-off (the hottest write path, incl. the
--        background geofence) would maintain one more index;
--      - entry_type = 'work' is most of the table, so a partial index on it
--        would save almost nothing.
--    Revisit when time_entries passes ~100k rows AND this plan shows a Seq
--    Scan with Execution Time over ~10 ms. If it does, add the index in its
--    own migration (CONCURRENTLY can't run inside a transaction block, and
--    the SQL editor wraps a paste in one — run that single statement alone).
-- ---------------------------------------------------------------------------
explain (analyze, buffers)
select staff_id, clock_in, clock_out
from time_entries
where staff_id = (select staff_id from time_entries
                   where entry_type = 'work'
                   group by staff_id order by count(*) desc limit 1)
  and entry_type = 'work'
  and clock_out is not null
  and clock_in >= now() - interval '30 days'
order by id;


-- ---------------------------------------------------------------------------
-- 3. A job's photos, newest first (components/job/job-photos.tsx,
--    mobile/lib/data/reads/jobPhotos.ts)
--    Expect: Index Scan using job_photos_job_id_created_at_idx (a Sort node
--    may sit on top for the mobile read's second key, id desc — cheap: one
--    job's photos).
-- ---------------------------------------------------------------------------
explain (analyze, buffers)
select id, storage_path, photo_type, created_at
from job_photos
where job_id = (select job_id from job_photos
                 group by job_id order by count(*) desc limit 1)
order by created_at desc;
