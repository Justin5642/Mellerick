-- ============================================================================
-- Remove the "Simpro total (inc tax): $…" line from every imported job's notes.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-16, via SQL editor, one run).
-- Verified afterwards (service role, read-only): 0 jobs with a Simpro total
-- line, 0 jobs whose notes contain a dollar amount, and no job's updated_at
-- moved (the triggers really were off).
--
-- WHY — A MONEY-BOUNDARY BREACH
-- Technicians must never see a dollar figure (HANDOVER §2). Both Simpro import
-- scripts (scripts/migrate-simpro-jobs.mjs, scripts/backfill-recent-simpro-jobs.mjs)
-- appended `Simpro total (inc tax): $<amount>` to jobs.notes. jobs.notes is in
-- the technician sync stream (tech_jobs) and on the web job page, so every
-- imported job showed its value to any technician assigned to it. The four
-- layers in §2 guard money COLUMNS; a figure written into a free-text column
-- walked straight past all of them.
--
-- Measured 15 Oct 2026 (read-only, service role): 2,513 jobs, 2,501 carrying
-- the line, all in exactly this format. With the line removed, NO job's notes
-- contain any other dollar amount or GST figure. The scripts no longer write it
-- (same change), and tests/unit/simpro-import-no-money.test.ts keeps it out.
--
-- Two job DESCRIPTIONS also name a price (jobs 1259 and 683). Free text written
-- by a person — left for the office to edit, not rewritten here.
--
-- WHY THE TRIGGERS ARE OFF FOR THE UPDATE
-- A normal UPDATE on 2,501 jobs would fire update_jobs_updated_at and 0068's
-- zz_jobs_sync_window, stamping every one of them as "active today". That would
-- pull years of closed jobs back into every technician's and office device's
-- sync window, and make every job look edited today. Disabling USER triggers
-- (not the foreign-key constraint triggers) for this one statement inside the
-- transaction avoids both. Logical replication still carries the new text, so
-- devices that hold one of these jobs receive the cleaned notes — which is the
-- point.
--
-- If the SQL editor refuses `disable trigger` ("must be owner of table jobs"),
-- nothing has changed (it is one transaction) — report it rather than running
-- the UPDATE without it.
-- ============================================================================

begin;

alter table jobs disable trigger user;

update jobs
set notes = nullif(regexp_replace(notes, '\n?Simpro total \(inc tax\):[^\n]*', '', 'g'), '')
where notes ~ 'Simpro total \(inc tax\):';

alter table jobs enable trigger user;

do $$
declare
  n int;
begin
  select count(*) into n from jobs where notes ~ 'Simpro total';
  if n > 0 then
    raise exception 'ASSERTION FAILED: % job(s) still carry a Simpro total line', n;
  end if;

  -- Not an exception: the measured state is zero, but a person may type a
  -- price into notes at any time. Surfaced so whoever applies this sees it.
  select count(*) into n from jobs where notes ~ '\$\s?[0-9]';
  raise notice 'jobs whose notes still contain a dollar amount: %', n;

  -- The triggers must be back on, or every later edit silently skips
  -- updated_at and the sync windows.
  select count(*) into n
  from pg_trigger
  where tgrelid = 'jobs'::regclass and not tgisinternal and tgenabled = 'D';
  if n > 0 then
    raise exception 'ASSERTION FAILED: % trigger(s) on jobs left disabled', n;
  end if;
end;
$$;

commit;
