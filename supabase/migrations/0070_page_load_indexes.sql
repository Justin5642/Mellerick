-- ============================================================================
-- Indexes for the filters and sorts the web dashboard actually runs.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-15, via SQL editor).
-- Independent of 0053/0069. Plain CREATE INDEX (not CONCURRENTLY, which the SQL
-- editor's transaction cannot run): these tables are small (jobs ~830 rows,
-- time_entries a few thousand), so each build holds its write lock for well
-- under a second.
--
-- PERFORMANCE ONLY. No column, constraint or policy changes.
-- ============================================================================

-- "Recent jobs" on the dashboard home (order by created_at desc limit 8), the
-- paginated Jobs list, and a customer's jobs. Without it every one sorts the
-- whole table to return the first page.
create index if not exists jobs_created_at_idx on jobs (created_at desc);

-- Invoices list: order by (created_at desc, id desc) with range pagination.
create index if not exists invoices_created_at_id_idx on invoices (created_at desc, id desc);

-- Quotes list and a customer's quotes: order by created_at desc.
create index if not exists quotes_created_at_idx on quotes (created_at desc);

-- lib/google.ts looks a job up by google_event_id once per calendar event, from
-- the poll-calendar cron every 10 minutes — a sequential scan of jobs each time.
create index if not exists jobs_google_event_id_idx on jobs (google_event_id)
  where google_event_id is not null;

-- Reports: work time entries since a cutoff (entry_type = 'work' and
-- clock_in >= …).
create index if not exists time_entries_clock_in_idx on time_entries (clock_in);

-- Foreign key with no index (0005). Nothing filters on it, which is why 0052
-- skipped it — but deleting a job makes Postgres check this column for
-- references, which scans time_entries in full. The partial index still serves
-- that check: an equality test implies the column is not null.
create index if not exists time_entries_travel_from_job_id_idx on time_entries (travel_from_job_id)
  where travel_from_job_id is not null;

-- Invoices "ready to invoice" and Approvals: unbilled variations by status.
create index if not exists job_variations_unbilled_status_idx on job_variations (status)
  where invoice_id is null;

-- Approvals queue: completed jobs whose admin sign-off is pending.
create index if not exists jobs_admin_pending_status_idx on jobs (status)
  where admin_status = 'pending';
