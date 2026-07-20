import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api/guards";

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

  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=au`,
    { headers: { "User-Agent": "MellerickApp/1.0 (plumbing-management)" } }
  );

  const data = await res.json();
  if (!data[0]) return NextResponse.json({ error: "Address not found" }, { status: 404 });

  return NextResponse.json({
    lat: parseFloat(data[0].lat),
    lng: parseFloat(data[0].lon),
    display: data[0].display_name,
  });
}
