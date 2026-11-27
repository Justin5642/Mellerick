import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { consumeRateLimit, rateLimitedResponse, DISTANCE_LIMIT } from "@/lib/api/rate-limit";
import { siteAddress } from "@/lib/geocode";
import {
  DISTANCE_ERRORS,
  DISTANCE_TEXT_MAX,
  distanceAnswer,
  osrmRouteMeters,
  resolvePlace,
  type ResolvedPlace,
} from "@/lib/distance";

// Road distance for a float move or a truck load (27 Nov 2026).
//
//   GET  /api/distance?from=…&to=…[&jobId=…]
//   POST /api/distance { from, to, jobId? }
//
// Each end is "lat,lng", a place or address ("Boral Wollert", "Wollert tip"),
// or the word "site" — the job's site (its pin when set, else its address),
// read as the CALLER so RLS decides whether they may see that job. Any active
// staff member may ask (technicians log the loads). No money in or out.
// Errors are fixed sentences; the phone and web keep the km field editable.

type Body = { from?: unknown; to?: unknown; jobId?: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function handle(request: NextRequest, body: Body) {
  const guard = await requireRole(request, ["admin", "office", "technician"]);
  if (!guard.ok) return guard.response;

  const from = typeof body.from === "string" ? body.from.trim() : "";
  const to = typeof body.to === "string" ? body.to.trim() : "";
  const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
  if (!from || !to) return fail(DISTANCE_ERRORS.missing, 400);
  if (from.length > DISTANCE_TEXT_MAX || to.length > DISTANCE_TEXT_MAX) return fail(DISTANCE_ERRORS.tooLong, 400);
  const wantsSite = from.toLowerCase() === "site" || to.toLowerCase() === "site";
  if (wantsSite && !UUID.test(jobId)) return fail(DISTANCE_ERRORS.noJob, 400);

  if (!(await consumeRateLimit(guard.userId, DISTANCE_LIMIT))) return rateLimitedResponse();

  try {
    // The job's site, once, if either end asks for it.
    let site: string | ResolvedPlace | null = null;
    if (wantsSite) {
      const supabase = await callerClient(request);
      const { data, error } = await supabase
        .from("jobs")
        .select("id, sites(name, address_line1, address_line2, suburb, state, postcode, site_lat, site_lng)")
        .eq("id", jobId)
        .maybeSingle();
      if (error) {
        console.error("distance: job read failed", error.code, error.message);
        return fail(DISTANCE_ERRORS.unavailable, 502);
      }
      if (!data) return fail(DISTANCE_ERRORS.jobNotFound, 404);
      const s = (Array.isArray(data.sites) ? data.sites[0] : data.sites) as
        | { name?: string | null; address_line1?: string | null; address_line2?: string | null; suburb?: string | null; state?: string | null; postcode?: string | null; site_lat?: number | null; site_lng?: number | null }
        | null;
      const label = [s?.address_line1, s?.suburb].map((p) => (p ?? "").trim()).filter(Boolean).join(", ") || (s?.name ?? "").trim() || "Job site";
      if (s && typeof s.site_lat === "number" && typeof s.site_lng === "number") {
        site = { lat: s.site_lat, lng: s.site_lng, label, precise: true };
      } else {
        const addr = s ? siteAddress(s) : null;
        if (!addr) return fail(DISTANCE_ERRORS.noSite, 404);
        const found = await resolvePlace(addr);
        // The site's own address — label it as the office knows it.
        site = found ? { ...found, label } : null;
      }
    }

    const resolveEnd = async (text: string): Promise<ResolvedPlace | null> =>
      text.toLowerCase() === "site" ? (site as ResolvedPlace | null) : resolvePlace(text);

    const a = await resolveEnd(from);
    if (!a) return fail(DISTANCE_ERRORS.fromNotFound, 404);
    const b = await resolveEnd(to);
    if (!b) return fail(DISTANCE_ERRORS.toNotFound, 404);

    const meters = await osrmRouteMeters(a, b);
    if (meters === null) return fail(DISTANCE_ERRORS.noRoute, 404);
    return NextResponse.json(distanceAnswer(a, b, meters));
  } catch (err) {
    console.error("distance: lookup failed", err instanceof Error ? err.message : String(err));
    return fail(DISTANCE_ERRORS.unavailable, 502);
  }
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  return handle(request, { from: q.get("from") ?? undefined, to: q.get("to") ?? undefined, jobId: q.get("jobId") ?? undefined });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Body;
  return handle(request, body && typeof body === "object" ? body : {});
}
