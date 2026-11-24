import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin, requireUser } from "@/lib/api/guards";
import { ADDRESS_SEARCH_MAX_LENGTH, geocodeAddress, searchAddresses } from "@/lib/geocode";

// Simple fixed-window in-memory rate limit, keyed per user. Nominatim's usage
// policy is strict (1 req/sec); this also stops a compromised session from
// hammering it under our shared User-Agent and getting the app IP-banned.
// Per-instance only — good enough for this low-traffic internal tool; a
// distributed limiter would need a shared store.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now > entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

export async function GET(request: NextRequest) {
  // ?search=1&q=… — several suggestions (street/suburb matches included,
  // labelled approximate) for the office's "Set location on map" dialog. A
  // person picks one and confirms the pin, so vaguer matches are fine there;
  // office/admin only, like setting a site's pin on the web (sites are
  // office-writable, 0064). Shares the per-user limit below.
  if (request.nextUrl.searchParams.get("search") === "1") {
    const guard = await requireOfficeOrAdmin(request);
    if (!guard.ok) return guard.response;
    if (rateLimited(guard.userId)) {
      return NextResponse.json({ error: "Rate limit exceeded, try again shortly" }, { status: 429 });
    }
    const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
    if (q.length < 3) return NextResponse.json({ error: "Type at least 3 characters" }, { status: 400 });
    if (q.length > ADDRESS_SEARCH_MAX_LENGTH) return NextResponse.json({ error: "That address is too long" }, { status: 400 });
    try {
      const results = await searchAddresses(q, { signal: AbortSignal.timeout(10_000) });
      return NextResponse.json({ results });
    } catch (err) {
      console.error("geocode: search failed", err);
      return NextResponse.json({ error: "Address lookup is unavailable, try again shortly" }, { status: 502 });
    }
  }

  // Authenticated staff only — this was previously an open proxy to a
  // third-party geocoder under the app's shared User-Agent.
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;

  if (rateLimited(guard.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded, try again shortly" }, { status: 429 });
  }

  const address = request.nextUrl.searchParams.get("address");
  if (!address) return NextResponse.json({ error: "No address provided" }, { status: 400 });

  // Same lookup and precision rule as the hourly site geocoder (lib/geocode):
  // a street- or suburb-level guess would put the auto clock-in geofence in the
  // wrong place, so it is reported as not found instead.
  let found;
  try {
    // approx=1: the "Set location on map" dialog centring itself. It never
    // saves this point — only the pin the user places.
    const approx = request.nextUrl.searchParams.get("approx") === "1";
    found = await geocodeAddress(address, { signal: AbortSignal.timeout(10_000), approx });
  } catch (err) {
    console.error("geocode: lookup failed", err);
    return NextResponse.json({ error: "Address lookup is unavailable, try again shortly" }, { status: 502 });
  }
  if (!found) return NextResponse.json({ error: "Couldn't find that exact address" }, { status: 404 });
  return NextResponse.json(found);
}
