-- ============================================================================
-- Small plant & equipment with a day rate, and "tools used today" on a job.
--
-- STATUS: DRAFT — NOT APPLIED. Gate test:
-- supabase/tests/0100_plant_equipment_day_rates_test.sql
--
-- WHY (Justin, 14 Nov 2026): demo saws, compactors, core drills and the like
-- get used on jobs every week and their wear, repairs and replacement were
-- never costed to anything. Each item now carries a DAY RATE, and a
-- technician taps the tools they used on a job that day; each tap costs the
-- job one day at that rate.
--
-- Decisions (Justin, 14 Nov 2026):
--   * Owned items are costed at a HIRE-EQUIVALENT day rate (market hire rate,
--     editable per item) — not depreciation, which small tools rarely have
--     enough logged history for.
--   * Hired-in items are NOT logged here: the hire invoice goes on the job
--     (supplier order / expense) as now, so nothing is counted twice.
--   * Full days only: one tap = one day; a tool counts once per job per day.
--
-- WHAT IT ADDS
--   equipment.day_rate          $ per day used, ex GST. 0 = not day-rated.
--   equipment_usage_log.days    0 or 1. A tool-day row has days = 1 and no
--                               hours or loads; costed days × day_rate.
--   one tool-day per job per item per date (partial unique index), so a double
--   tap — or two crew both ticking the saw — cannot bill it twice.
--   The existing 'tool' category is the "Plant & equipment" list (relabelled in
--   the apps); nothing used it before.
--
-- SEED: the eight items Justin listed, at Melbourne hire rates researched on
-- 14 Nov 2026 (converted to ex GST, rounded). Added only when no equipment of
-- that name exists, so re-running is harmless and renamed items are left alone.
-- ============================================================================

alter table equipment add column if not exists day_rate numeric(10,2) not null default 0;
alter table equipment drop constraint if exists equipment_day_rate_check;
alter table equipment add constraint equipment_day_rate_check check (day_rate >= 0);
comment on column equipment.day_rate is
  'Cost per day used on a job, ex GST (0100). Hire-equivalent rate for owned small plant. 0 = not day-rated.';

alter table equipment_usage_log add column if not exists days integer not null default 0;
alter table equipment_usage_log drop constraint if exists equipment_usage_log_days_check;
alter table equipment_usage_log add constraint equipment_usage_log_days_check check (days in (0, 1));
comment on column equipment_usage_log.days is
  'Full days used (0100): 1 for a "tool used today" entry, costed at equipment.day_rate; 0 otherwise.';

alter table equipment_usage_log drop constraint if exists equipment_usage_log_something_used;
alter table equipment_usage_log add constraint equipment_usage_log_something_used
  check (hours > 0 or loads > 0 or days > 0);

create unique index if not exists equipment_usage_log_one_tool_day_idx
  on equipment_usage_log (job_id, equipment_id, usage_date)
  where days > 0;

insert into equipment (name, category, day_rate, notes)
select v.name, 'tool', v.day_rate, v.notes
from (values
  ('Demo saw (350mm petrol)',  150.00, 'Day rate from Melbourne hire rates, Nov 2026 (~$165/day inc GST).'),
  ('Trench compactor (rammer)', 100.00, 'Day rate from Melbourne hire rates, Nov 2026 ($78–$140/day).'),
  ('Plate compactor',            70.00, 'Day rate from Melbourne hire rates, Nov 2026 ($60–$87/day, ~80kg plate).'),
  ('Core hole drill',           140.00, 'Day rate from Melbourne hire rates, Nov 2026 ($108–$230/day). Diamond bits extra.'),
  ('Jackhammer / breaker',       80.00, 'Day rate from Melbourne hire rates, Nov 2026 ($60–$108/day, electric).'),
  ('Drain camera',              130.00, 'Day rate from Melbourne hire rates, Nov 2026 ($120–$300/day).'),
  ('Drain jetter',               90.00, 'Day rate from Melbourne hire rates, Nov 2026 ($70–$175/day, portable; not truck-mounted).'),
  ('Pipe & cable locator',      130.00, 'Day rate from Melbourne hire rates, Nov 2026 ($73–$185/day).')
) as v(name, day_rate, notes)
where not exists (select 1 from equipment e where lower(e.name) = lower(v.name));

notify pgrst, 'reload schema';
