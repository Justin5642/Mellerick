#!/usr/bin/env node
/**
 * One-off: give every site without coordinates a map location, so the auto
 * clock-in geofence (150 m) can work there. 1,441 of 1,443 sites had none on
 * 20 Oct 2026 — Simpro imports were never geocoded. /api/sites/geocode-missing
 * keeps new ones filled hourly after this.
 *
 * Uses OpenStreetMap Nominatim, one lookup a second (its usage policy), so the
 * full backlog takes ~25 minutes. Sites on open jobs go first.
 *
 * ONLY FILLS BLANKS. A site that already has coordinates is never touched.
 * A result vaguer than a building/address point (a street or a suburb) is
 * treated as not found — a wrong fence clocks people in at the wrong place,
 * which is worse than no fence. siteAddress / isPreciseEnough mirror
 * lib/geocode.ts; keep them in step.
 *
 * REQUIRES (in .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * USAGE:
 *   node --env-file=.env.local scripts/geocode-sites.mjs [--commit] [--limit=<n>]
 * Without --commit it is a dry run: lookups happen, nothing is written.
 * Re-runnable: it only ever looks at sites still missing coordinates.
 */

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;
const PAUSE_MS = 1_100;
const USER_AGENT = "MellerickApp/1.0 (plumbing-management)";

export function siteAddress(s) {
  const line1 = (s.address_line1 ?? "")
    .trim()
    .replace(/^(unit|u|shop|suite|lot)\s*\d+[a-z]?\s*[/,]?\s*/i, "")
    .replace(/^\d+[a-z]?\s*\/\s*/i, "");
  if (!line1) return null;
  const locality = [s.suburb, s.state, s.postcode].map((p) => (p ?? "").trim()).filter(Boolean).join(" ");
  return [line1, locality, "Australia"].filter(Boolean).join(", ");
}

const PRECISE_TYPES = new Set(["house", "building", "residential", "apartments", "detached", "semidetached_house", "terrace", "commercial", "industrial", "retail", "office", "warehouse", "yes"]);
export function isPreciseEnough(r) {
  if (r.addresstype && ["house", "building", "place"].includes(r.addresstype)) return true;
  if (r.class === "building") return true;
  if (r.class === "place" && r.type === "house") return true;
  return !!r.type && PRECISE_TYPES.has(r.type) && r.class !== "highway" && r.class !== "boundary";
}

async function geocode(address) {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=jsonv2&limit=1&countrycodes=au`,
    { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) }
  );
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const data = await res.json();
  const top = data[0];
  if (!top || !isPreciseEnough(top)) return null;
  return { lat: parseFloat(top.lat), lng: parseFloat(top.lon) };
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing env. Run with: node --env-file=.env.local scripts/geocode-sites.mjs");
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const sites = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("sites")
      .select("id, address_line1, suburb, state, postcode, jobs(status)")
      .is("site_lat", null)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(`reading sites: ${error.message}`);
    sites.push(...data);
    if (data.length < 1000) break;
  }
  const open = (s) => (s.jobs ?? []).some((j) => j.status !== "completed" && j.status !== "cancelled");
  const queue = sites.sort((a, b) => Number(open(b)) - Number(open(a))).slice(0, LIMIT);
  console.log(`${sites.length} sites without coordinates; processing ${queue.length}${COMMIT ? "" : " (DRY RUN — nothing written)"}.`);

  const report = { mode: COMMIT ? "commit" : "dry-run", located: 0, notFound: [], failed: [] };
  for (const [i, site] of queue.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
    const address = siteAddress(site);
    try {
      const found = address ? await geocode(address) : null;
      if (COMMIT) {
        const { error } = await supabase
          .from("sites")
          .update(found ? { site_lat: found.lat, site_lng: found.lng, geocode_attempted_at: new Date().toISOString() } : { geocode_attempted_at: new Date().toISOString() })
          .eq("id", site.id)
          .is("site_lat", null); // only fill blanks, even if someone set it meanwhile
        if (error) throw new Error(error.message);
      }
      if (found) report.located++;
      else report.notFound.push({ id: site.id, address, openJob: open(site) });
    } catch (err) {
      report.failed.push({ id: site.id, address, error: String(err?.message ?? err) });
    }
    if ((i + 1) % 50 === 0 || i + 1 === queue.length) {
      console.log(`  ${i + 1}/${queue.length}  located ${report.located}, not found ${report.notFound.length}, failed ${report.failed.length}`);
    }
  }

  const outDir = path.join(__dirname, "data");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `geocode-sites-${report.mode}-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n${COMMIT ? "Located" : "Would locate"} ${report.located} of ${queue.length}. Not found: ${report.notFound.length} (${report.notFound.filter((n) => n.openJob).length} on open jobs). Failed: ${report.failed.length}.`);
  console.log(`Report: ${path.relative(process.cwd(), outFile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
