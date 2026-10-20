import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/api/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { geocodeAddress, siteAddress } from "@/lib/geocode";
import { reportError } from "@/lib/monitoring";

// Hourly (vercel.json): fill in coordinates for sites that have none, so the
// auto clock-in geofence works however a site was added — the web "Add site"
// dialog, a PO, the mobile app, or a Simpro import, which never geocoded.
//
// Nominatim allows one request a second, so a run handles a small batch with a
// pause between lookups; scripts/geocode-sites.mjs does the one-off backlog.
// A lookup that finds nothing precise enough is remembered
// (sites.geocode_attempted_at, migration 0082) and not retried for a week.
// Sites on open jobs go first: those are the ones a technician might arrive at
// today.

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

  return NextResponse.json({ checked: queue.length, located, notFound, failed });
}
