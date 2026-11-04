import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/api/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { geocodeAddress, siteAddress, type SiteAddressParts } from "@/lib/geocode";
import { reportError } from "@/lib/monitoring";
import { MAX_READING_ACCURACY_M, pinFromClockOns, type ClockOnReading } from "@/lib/site-pin-from-clock";

// Hourly (vercel.json): fill in coordinates for sites that have none, so the
// auto clock-in geofence works however a site was added — the web "Add site"
// dialog, a PO, the mobile app, or a Simpro import, which never geocoded.
//
// Nominatim allows one request a second, so a run handles a small batch with a
// pause between lookups; scripts/geocode-sites.mjs does the one-off backlog.
// A lookup that finds nothing precise enough is remembered
// (sites.geocode_attempted_at, migration 0082) and not retried for a week.
// Sites on open jobs go first: those are the ones a technician might arrive at
// today. Before any of that, sites the geocoder can't place get a pin from
// where the crew clocked on by hand (lib/site-pin-from-clock.ts).

export const maxDuration = 60;

const BATCH = 25;
const PAUSE_MS = 1_100;
const RETRY_AFTER_DAYS = 7;

export async function GET(request: NextRequest) {
  const cron = requireCronSecret(request);
  if (!cron.ok) return cron.response;

  const admin = createAdminClient();
  const retryCutoff = new Date(Date.now() - RETRY_AFTER_DAYS * 86_400_000).toISOString();

  const { data: sites, error } = await admin
    .from("sites")
    .select("id, address_line1, address_line2, suburb, state, postcode, jobs(status)")
    .is("site_lat", null)
    // Archived sites take no new jobs, so nobody will arrive at one.
    .eq("is_active", true)
    .not("address_line1", "is", null)
    .or(`geocode_attempted_at.is.null,geocode_attempted_at.lt.${retryCutoff}`)
    .limit(200);
  if (error) {
    reportError(error, { route: "api/sites/geocode-missing" });
    return NextResponse.json({ error: "Could not read sites" }, { status: 500 });
  }

  const pinnedFromClockOns = await pinSitesFromClockOns(admin).catch((err) => {
    // Never blocks the geocoding below.
    console.error("geocode-missing: clock-on pins failed", err);
    reportError(err, { route: "api/sites/geocode-missing", step: "clock-on pins" });
    return 0;
  });

  const open = (s: { jobs?: { status: string }[] | null }) =>
    (s.jobs ?? []).some((j) => j.status !== "completed" && j.status !== "cancelled");
  const queue = [...(sites ?? [])].sort((a, b) => Number(open(b)) - Number(open(a))).slice(0, BATCH);

  let located = 0;
  let notFound = 0;
  let failed = 0;
  for (const [i, site] of queue.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
    const address = siteAddress(site);
    let found = null;
    try {
      found = address ? await geocodeAddress(address, { signal: AbortSignal.timeout(10_000) }) : null;
    } catch (err) {
      // Network or Nominatim trouble: leave it unmarked so the next run retries.
      console.error("geocode-missing: lookup failed", site.id, err);
      failed++;
      continue;
    }
    const { error: writeError } = await admin
      .from("sites")
      .update(
        found
          ? { site_lat: found.lat, site_lng: found.lng, geocode_attempted_at: new Date().toISOString() }
          : { geocode_attempted_at: new Date().toISOString() }
      )
      .eq("id", site.id);
    if (writeError) {
      console.error("geocode-missing: write failed", site.id, writeError);
      failed++;
    } else if (found) located++;
    else notFound++;
  }

  return NextResponse.json({ checked: queue.length, located, notFound, failed, pinnedFromClockOns });
}

// At most this many sites per run get a street lookup (one second apiece),
// leaving the rest of the minute for the geocoding above.
const CLOCK_PIN_SITES = 10;
const CLOCK_ON_LOOKBACK_DAYS = 60;

/**
 * Pins open jobs' sites that have none from where the crew clocked on by hand
 * (lib/site-pin-from-clock.ts). Returns how many sites it pinned.
 */
async function pinSitesFromClockOns(admin: ReturnType<typeof createAdminClient>): Promise<number> {
  const since = new Date(Date.now() - CLOCK_ON_LOOKBACK_DAYS * 86_400_000).toISOString();
  const { data: entries, error } = await admin
    .from("time_entries")
    .select("staff_id, clock_in, clock_in_lat, clock_in_lng, clock_in_accuracy, jobs!inner(status, site_id, sites!inner(id, site_lat, is_active, address_line1, address_line2, suburb, state, postcode))")
    .eq("entry_type", "work")
    .not("clock_in_lat", "is", null)
    .lte("clock_in_accuracy", MAX_READING_ACCURACY_M)
    .gte("clock_in", since)
    .order("clock_in", { ascending: false })
    .limit(1000);
  if (error) throw error;

  type Row = {
    staff_id: string;
    clock_in: string;
    clock_in_lat: number;
    clock_in_lng: number;
    clock_in_accuracy: number | null;
    jobs: { status: string; site_id: string; sites: SiteAddressParts & { id: string; site_lat: number | null; is_active: boolean } } | null;
  };
  const bySite = new Map<string, { site: SiteAddressParts; readings: ClockOnReading[] }>();
  for (const e of (entries ?? []) as unknown as Row[]) {
    const site = e.jobs?.sites;
    if (!site || site.site_lat != null || !site.is_active) continue;
    if (e.jobs!.status === "completed" || e.jobs!.status === "cancelled") continue;
    const entry = bySite.get(site.id) ?? { site, readings: [] };
    entry.readings.push({ staffId: e.staff_id, clockIn: e.clock_in, lat: Number(e.clock_in_lat), lng: Number(e.clock_in_lng), accuracy: e.clock_in_accuracy });
    bySite.set(site.id, entry);
  }

  let pinned = 0;
  for (const [i, [siteId, { site, readings }]] of [...bySite.entries()].slice(0, CLOCK_PIN_SITES).entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
    const address = siteAddress(site);
    let nearby: { lat: number; lng: number } | null = null;
    try {
      // Street- or suburb-level is enough here: it only rules out a clock-on
      // made somewhere else, it never becomes the pin.
      nearby = address ? await geocodeAddress(address, { signal: AbortSignal.timeout(10_000), approx: true }) : null;
    } catch (err) {
      console.error("geocode-missing: street lookup failed", siteId, err);
      continue;
    }
    const pin = pinFromClockOns(readings, nearby);
    if (!pin) continue;
    const { error: writeError } = await admin
      .from("sites")
      .update({ site_lat: pin.lat, site_lng: pin.lng, location_set_by: pin.staffId, location_set_at: new Date().toISOString() })
      .eq("id", siteId)
      .is("site_lat", null); // never moves a pin someone set in the meantime
    if (writeError) console.error("geocode-missing: clock-on pin write failed", siteId, writeError);
    else pinned++;
  }
  return pinned;
}
