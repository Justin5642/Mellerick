-- ============================================================================
-- Truck and plant usage against a job's cost centre, with truck loads
-- (Stage 7 of the 31 Oct 2026 workflow review).
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-31, via SQL editor). Gate test
-- supabase/tests/0091_plant_to_cost_centres_test.sql passed.
--
-- WHY (Justin, 31 Oct 2026): quarter-minus cartage — the truck picks up from
-- the quarry, tips on site, then carts spoil off — belongs to the Transport
-- cost centre, separate from the Below Ground Drainage work the crew does.
-- A dedicated driver logs it; truck cost is counted "both" per hour and per
-- load.
--
--   equipment_usage_log.cost_center_id  the job's PO line (po_cost_centers)
--                                       this usage is costed to; null =
--                                       untagged, as before
--   equipment_usage_log.loads           loads carted, 0 when it's hours only;
--                                       hours may now be 0 for loads only
--   equipment.cost_per_load             $ per load (admin sets it in Fleet);
--                                       office/admin only like the rest of
--                                       equipment's money (0035)
--
-- No new table, so no new grants (0088). RLS unchanged: a technician may log
-- usage on a job they can manage (0074); the phone gets equipment names, never
-- costs, through /api/jobs/[id]/plant-usage.
-- ============================================================================

alter table equipment_usage_log
  add column if not exists cost_center_id uuid references po_cost_centers(id) on delete set null;
alter table equipment_usage_log
  add column if not exists loads integer not null default 0;
alter table equipment_usage_log drop constraint if exists equipment_usage_log_loads_check;
alter table equipment_usage_log add constraint equipment_usage_log_loads_check check (loads >= 0);
-- Something must have been used: hours, loads, or both.
alter table equipment_usage_log drop constraint if exists equipment_usage_log_something_used;
alter table equipment_usage_log add constraint equipment_usage_log_something_used check (hours > 0 or loads > 0);
create index if not exists equipment_usage_log_cost_center_id_idx on equipment_usage_log(cost_center_id);

alter table equipment add column if not exists cost_per_load numeric(10,2) not null default 0;

comment on column equipment_usage_log.cost_center_id is
  'The job PO line (po_cost_centers) this usage is costed to (0091) — e.g. the job''s Transport line for cartage. Null = not tagged.';
comment on column equipment_usage_log.loads is
  'Loads carted (0091). Costed at equipment.cost_per_load on top of hours × cost per hour.';
comment on column equipment.cost_per_load is
  'Cost per load carted, ex GST (0091). Office/admin only.';
