-- ============================================================================
-- Where each clock-on and clock-off happened, and who moved a site's pin
-- (the clock extras left over from Stage 5, 31 Oct 2026 workflow review).
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-11-01, via SQL editor). Gate test
-- supabase/tests/0092_clock_location_and_site_pins_test.sql passed.
--
-- WHY: the office could not tell why an automatic clock fired, or whether a
-- manual clock-on happened on site. Each phone clock-on/off now records the
-- phone's position and its accuracy; the web Time tab shows how far that was
-- from the site and flags anything outside the 150 m fence. Nothing is
-- blocked — Justin kept automatic clocking, and a flag is for the office.
--
--   time_entries.clock_in_lat / _lng / _accuracy     position at clock-on
--   time_entries.clock_out_lat / _lng / _accuracy    position at clock-off
--                                                    (accuracy in metres;
--                                                    all null when the phone
--                                                    had no fix)
--   sites.location_set_by / location_set_at         a crew member pressed
--                                                    "Set site location here"
--                                                    (via /api/jobs/[id]/site-location)
--
-- time_entries uses COLUMN-LEVEL select grants (0045 — rate_override is
-- hidden), and 0045's grant list was computed once, when it ran. New columns
-- are therefore granted here explicitly, or every read naming them is refused.
-- ============================================================================

alter table time_entries add column if not exists clock_in_lat numeric;
alter table time_entries add column if not exists clock_in_lng numeric;
alter table time_entries add column if not exists clock_in_accuracy real;
alter table time_entries add column if not exists clock_out_lat numeric;
alter table time_entries add column if not exists clock_out_lng numeric;
alter table time_entries add column if not exists clock_out_accuracy real;

grant select (clock_in_lat, clock_in_lng, clock_in_accuracy, clock_out_lat, clock_out_lng, clock_out_accuracy)
  on time_entries to authenticated;

alter table sites add column if not exists location_set_by uuid references profiles(id) on delete set null;
alter table sites add column if not exists location_set_at timestamptz;

comment on column time_entries.clock_in_lat is
  'Phone position at clock-on (0092), with clock_in_lng and clock_in_accuracy (metres). Null = no fix.';
comment on column time_entries.clock_out_lat is
  'Phone position at clock-off (0092), with clock_out_lng and clock_out_accuracy (metres). Null = no fix.';
comment on column sites.location_set_at is
  'When a crew member set this site''s pin from where they stood (0092); location_set_by says who.';

notify pgrst, 'reload schema';
