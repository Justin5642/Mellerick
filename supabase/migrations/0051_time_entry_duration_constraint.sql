-- ============================================================================
-- A time entry cannot end before it starts, and cannot run for two days.
--
-- STATUS: ✅ APPLIED AND VERIFIED IN PRODUCTION (2026-08-22). Constraint
-- validated against all existing rows with no violations. Recorded in
-- supabase_migrations.schema_migrations.
--
-- ---------------------------------------------------------------------------
-- WHY
-- ---------------------------------------------------------------------------
-- Item 2.4. Nothing in the schema stops a reversed or absurd shift. Confirmed:
-- grepping `clock_out >` across supabase/ returns nothing, and neither
-- 0000_baseline.sql:362-371 nor schema.sql:350-358 carries a check.
--
-- Application code does guard it — but in four separate places, each with its
-- own arithmetic, and one of them is missing the plausibility cap:
--
--   lib/time-entry-hours.ts:20-22             the shared helper, capped
--   mobile .../backgroundClockTask.ts         capped (MAX_PLAUSIBLE_TRAVEL_HOURS)
--   components/job/time-entry-edit-dialog.tsx:128,137-138
--                                             inlines its own subtraction with a
--                                             `<= 0` guard and NO cap
--   mobile hoursBetween                       likewise uncapped
--
-- So an office edit or a manual mobile entry can still write a 200-hour shift.
-- And the guards null the derived `hours` while still persisting the reversed
-- pair, which reports/page.tsx then drops via `.not("hours","is",null)` — so the
-- entry vanishes from utilisation instead of showing up as the visible gap
-- lib/time-entry-hours.ts:20-22 says the office should see.
--
-- A constraint is the one place all four paths meet.
--
-- ---------------------------------------------------------------------------
-- MEASURED BEFORE WRITING, because a CHECK fails to validate if any existing
-- row violates it and the migration would abort:
--
--   time_entries with a clock_out          4
--     clock_out <= clock_in                0   <- nothing blocks this
--     longer than 18 hours                 0
--
-- (Production, 2026-08-10, via PostgREST.) Re-run the query in the VERIFY block
-- below immediately before applying — four rows is a small enough population
-- that one bad entry could appear between then and now.
--
-- ---------------------------------------------------------------------------
-- WHY 24 HOURS AND NOT 18
-- ---------------------------------------------------------------------------
-- The cap is a data-integrity backstop, not a payroll rule. 18h would be a
-- tighter fit to plausible work, but a legitimate overnight callout that spans
-- a long night must not be REFUSED by the database — the office would have no
-- way to record what actually happened. 24h rejects the class this exists for
-- (a clock-out that never fired and got closed days later) while refusing
-- nothing a human might genuinely need to enter.
-- ============================================================================

alter table time_entries drop constraint if exists time_entries_duration_sane;

alter table time_entries
  add constraint time_entries_duration_sane
  check (
    clock_out is null
    or (clock_out > clock_in and clock_out <= clock_in + interval '24 hours')
  );

comment on constraint time_entries_duration_sane on time_entries is
  'A closed time entry must end after it starts and within 24 hours. Four code '
  'paths compute duration independently and one (time-entry-edit-dialog.tsx) '
  'has no plausibility cap, so this is the single place they all meet. An open '
  'entry (clock_out null) is untouched — that is a shift in progress.';

-- ---------------------------------------------------------------------------
-- Assert it is actually enforced, rather than merely present.
-- ---------------------------------------------------------------------------
do $$
declare
  ok boolean := false;
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'time_entries'::regclass and conname = 'time_entries_duration_sane'
  ) then
    raise exception 'ASSERTION FAILED: the constraint was not created';
  end if;

  -- Prove it REFUSES, not just that it exists. A constraint written as
  -- `check (true)` would satisfy the existence test above.
  --
  -- The probe needs a job and a profile to point at, and MIGRATIONS RUN BEFORE
  -- SEEDS — in CI (.github/workflows/ci.yml applies the history at :171-174 and
  -- seeds at :213) both tables are empty at this moment. An INSERT ... SELECT
  -- over an empty table inserts nothing and raises nothing, so a naive probe
  -- would conclude "the reversed entry was ACCEPTED" and fail the build for a
  -- reason that has nothing to do with the constraint.
  --
  -- So: only probe when there is something to probe with, and say plainly when
  -- there is not. An inconclusive check must never be reported as a pass or a
  -- failure.
  if exists (select 1 from jobs) and exists (select 1 from profiles) then
    begin
      insert into time_entries (job_id, staff_id, clock_in, clock_out, entry_type)
      select (select id from jobs limit 1),
             (select id from profiles limit 1),
             now(),
             now() - interval '1 hour',   -- ends BEFORE it starts
             'work';
    exception
      when check_violation then ok := true;
      when others then
        raise exception 'ASSERTION INCONCLUSIVE: the reversed-entry probe failed with % (%)', sqlstate, sqlerrm;
    end;

    if not ok then
      raise exception 'ASSERTION FAILED: a reversed time entry was ACCEPTED';
    end if;

    -- Undo the probe if it somehow landed. It should not have.
    delete from time_entries where clock_out < clock_in;
  else
    raise warning
      'time_entries_duration_sane created, but NOT probed: no jobs/profiles exist yet. '
      'Re-run the VERIFY block below against a seeded database before trusting it.';
  end if;
end;
$$;

-- ============================================================================
-- BEFORE APPLYING — run this and expect zero rows. If it returns any, the
-- ALTER will abort; fix or delete them first and record what you did.
--
--   select id, staff_id, clock_in, clock_out,
--          round(extract(epoch from (clock_out - clock_in)) / 3600, 2) as hours
--     from time_entries
--    where clock_out is not null
--      and (clock_out <= clock_in or clock_out > clock_in + interval '24 hours')
--    order by clock_in desc;
--
-- AFTER APPLYING
--
--   1. Edit a time entry in the office UI and set the finish before the start.
--      It must be refused with a database error rather than silently saving a
--      null `hours`.
--   2. FOLLOW-UP, NOT IN THIS MIGRATION: components/job/time-entry-edit-dialog.tsx
--      will now surface a raw Postgres message. Give it the same treatment the
--      other write paths got — catch the check_violation and say "a shift cannot
--      finish before it starts".
--   3. FOLLOW-UP: reports/page.tsx drops entries with a null `hours`
--      (`.not("hours","is",null)`), so a reversed pair currently disappears from
--      utilisation rather than showing as a gap. With this constraint the pair
--      can no longer be written, but pre-existing nulls remain — decide whether
--      to surface them.
-- ============================================================================
