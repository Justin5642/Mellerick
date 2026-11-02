-- ============================================================================
-- A clock-on fence size per site.
--
-- STATUS: DRAFT, not applied yet.
--
-- WHY (Justin, 2 Nov 2026): "some of the bigger jobs, 150 meters would not be
-- big enough to cover the site." The auto-clock fence was 150 m for every
-- site. A subdivision or a long civil job runs well past that, so the crew
-- were clocked off while still on the job.
--
--   sites.geofence_radius_m   the arrival fence in metres, 100–1000. Null =
--                             the standard 150 m. The phone clocks off at
--                             this plus 100 m (the wobble buffer from Stage 5).
--
-- Set by the office on the job's Site card. Sites are office-written already
-- (RLS unchanged); no column-level grants on sites.
-- ============================================================================

alter table sites add column if not exists geofence_radius_m integer;
alter table sites drop constraint if exists sites_geofence_radius_m_range;
alter table sites add constraint sites_geofence_radius_m_range
  check (geofence_radius_m is null or geofence_radius_m between 100 and 1000);

comment on column sites.geofence_radius_m is
  'Auto clock-on fence for this site in metres, 100–1000 (0094). Null = the standard 150 m. Clock-off is this plus 100 m.';

notify pgrst, 'reload schema';
