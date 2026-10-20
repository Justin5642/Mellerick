import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api/guards";
import { geocodeAddress } from "@/lib/geocode";

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
    found = await geocodeAddress(address, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    console.error("geocode: lookup failed", err);
    return NextResponse.json({ error: "Address lookup is unavailable, try again shortly" }, { status: 502 });
  }
  if (!found) return NextResponse.json({ error: "Couldn't find that exact address" }, { status: 404 });
  return NextResponse.json(found);
}
