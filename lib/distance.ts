// Road distance for floats and truck loads (27 Nov 2026).
//
// FREE OpenStreetMap services, no key: Nominatim (lib/geocode.ts) turns a
// quarry, tip or typed address into a point, and OSRM's public demo server
// (router.project-osrm.org) gives the driving distance between two points.
//
// Etiquette: the demo server is for light use ("fair use" — no heavy or
// automated traffic). One OSRM request per lookup, an 8 s timeout, and
// identical lookups are answered from this process's memory. Nominatim allows
// 1 request a second, so its calls here are spaced. If volume ever grows, a
// self-hosted OSRM or a paid routing service is the upgrade path — only
// `osrmRouteMeters` changes.
//
// No money anywhere: places, kilometres and a precision flag only. Technicians
// use it too.

import { NOMINATIM_USER_AGENT, isPreciseEnough } from "@/lib/geocode";

export const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
export const DISTANCE_TIMEOUT_MS = 8_000;
export const DISTANCE_TEXT_MAX = 200;

/** Fixed sentences — the route never passes a third party's text through. */
export const DISTANCE_ERRORS = {
  missing: "Give both ends of the trip.",
  tooLong: "That place name is too long.",
  noJob: "Give the job to measure from its site.",
  jobNotFound: "That job wasn't found.",
  noSite: "The job has no site address — type the km in.",
  fromNotFound: "Couldn't find the start of the trip on the map — type the km in.",
  toNotFound: "Couldn't find the end of the trip on the map — type the km in.",
  noRoute: "No road route found between those places — type the km in.",
  unavailable: "Distance lookup is unavailable right now — type the km in.",
} as const;

export interface Point {
  lat: number;
  lng: number;
}

export interface ResolvedPlace extends Point {
  label: string;
  /** false = only a street, suburb or area was matched — the km are approximate. */
  precise: boolean;
}

export interface DistanceAnswer {
  km: number;
  from: { label: string; precise: boolean };
  to: { label: string; precise: boolean };
  /** Either end matched only approximately. */
  approximate: boolean;
}

/** "-37.6, 144.9" → a point; anything else (or out of range) → null. */
export function parseCoordinates(text: string): Point | null {
  const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Metres → km, rounded UP to 0.1 km (a driver is never paid short). */
export function roundUpKm(meters: number): number {
  if (!Number.isFinite(meters) || meters <= 0) return 0;
  // Work in tenths of a km; the epsilon keeps 2300 m at 2.3 rather than 2.4.
  return Math.ceil(meters / 100 - 1e-9) / 10;
}

/** OSRM's answer → the first route's metres, or null when there is no route. */
export function shapeOsrmRoute(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { code?: unknown; routes?: unknown };
  if (b.code !== "Ok" || !Array.isArray(b.routes) || b.routes.length === 0) return null;
  const meters = Number((b.routes[0] as { distance?: unknown })?.distance);
  return Number.isFinite(meters) && meters >= 0 ? meters : null;
}

type NominatimRow = { lat?: string; lon?: string; display_name?: string; name?: string; class?: string; type?: string; addresstype?: string };

// Areas and streets: their centre can be kilometres from the real gate.
const AREA_ADDRESS_TYPES = new Set([
  "road", "suburb", "city", "town", "village", "hamlet", "locality", "municipality", "county", "state", "region",
  "postcode", "neighbourhood", "quarter", "city_district", "district", "country", "isolated_dwelling",
]);

/**
 * Good enough for a distance? A building or address point always is (the
 * geofence rule, lib/geocode.ts); for a quarry or tip a named place (a POI,
 * a quarry's land use) is too. A street, suburb or bigger area is approximate.
 */
export function isPreciseForDistance(row: NominatimRow): boolean {
  if (isPreciseEnough(row)) return true;
  if (row.class === "highway" || row.class === "boundary") return false;
  if (row.class === "place" && row.type !== "house") return false;
  if (row.addresstype && AREA_ADDRESS_TYPES.has(row.addresstype)) return false;
  return !!row.class;
}

/** A short label for a Nominatim row: "Boral Wollert, Wollert" / "12 Smith Street, Epping". */
export function placeLabel(row: NominatimRow): string {
  const parts = (row.display_name ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && /^\d+[a-z]?(?:[-/]\d+[a-z]?)?$/i.test(parts[0])) parts.splice(0, 2, `${parts[0]} ${parts[1]}`);
  return parts.slice(0, 2).join(", ") || (row.name ?? "").trim();
}

// ── Small process cache ─────────────────────────────────────────────────────

const CACHE_MAX = 300;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

class Lru<V> {
  private map = new Map<string, { value: V; at: number }>();
  get(key: string, now = Date.now()): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (now - hit.at > CACHE_TTL_MS) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(key: string, value: V, now = Date.now()) {
    this.map.delete(key);
    this.map.set(key, { value, at: now });
    while (this.map.size > CACHE_MAX) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  clear() {
    this.map.clear();
  }
}

const placeCache = new Lru<ResolvedPlace | null>();
const routeCache = new Lru<number | null>();

/** Tests only. */
export function clearDistanceCaches() {
  placeCache.clear();
  routeCache.clear();
  lastNominatimAt = 0;
}

// Nominatim: at most one request a second from this process.
let lastNominatimAt = 0;
async function nominatimSlot() {
  const wait = lastNominatimAt + 1_100 - Date.now();
  lastNominatimAt = Math.max(Date.now(), lastNominatimAt + 1_100);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/**
 * A typed place → its best Australian match (precise or not — the answer says
 * which), or null when nothing matches. Coordinates are taken as given.
 * Throws on a network/HTTP failure.
 */
export async function resolvePlace(text: string): Promise<ResolvedPlace | null> {
  const t = text.trim().slice(0, DISTANCE_TEXT_MAX);
  if (!t) return null;
  const coords = parseCoordinates(t);
  if (coords) return { ...coords, label: `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`, precise: true };
  const key = t.toLowerCase().replace(/\s+/g, " ");
  const cached = placeCache.get(key);
  if (cached !== undefined) return cached;
  await nominatimSlot();
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(t)}&format=jsonv2&limit=1&countrycodes=au`,
    { headers: { "User-Agent": NOMINATIM_USER_AGENT }, signal: AbortSignal.timeout(DISTANCE_TIMEOUT_MS) }
  );
  if (!res.ok) throw new Error(`Nominatim answered ${res.status}`);
  const data = (await res.json()) as unknown;
  const top = Array.isArray(data) ? (data[0] as NominatimRow | undefined) : undefined;
  const lat = Number(top?.lat);
  const lng = Number(top?.lon);
  const place: ResolvedPlace | null =
    top && top.lat != null && top.lon != null && Number.isFinite(lat) && Number.isFinite(lng)
      ? { lat, lng, label: placeLabel(top) || t, precise: isPreciseForDistance(top) }
      : null;
  placeCache.set(key, place);
  return place;
}

const pointKey = (p: Point) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`;

/** Driving metres between two points (one OSRM request), or null for no route. Throws on a network/HTTP failure. */
export async function osrmRouteMeters(a: Point, b: Point): Promise<number | null> {
  const key = `${pointKey(a)};${pointKey(b)}`;
  const cached = routeCache.get(key);
  if (cached !== undefined) return cached;
  const res = await fetch(`${OSRM_BASE}/${key}?overview=false`, {
    headers: { "User-Agent": NOMINATIM_USER_AGENT },
    signal: AbortSignal.timeout(DISTANCE_TIMEOUT_MS),
  });
  // OSRM answers 400 with code "NoRoute" / "NoSegment" for unroutable points.
  if (!res.ok && res.status !== 400) throw new Error(`OSRM answered ${res.status}`);
  const meters = shapeOsrmRoute(await res.json().catch(() => null));
  routeCache.set(key, meters);
  return meters;
}

export function distanceAnswer(from: ResolvedPlace, to: ResolvedPlace, meters: number): DistanceAnswer {
  return {
    km: roundUpKm(meters),
    from: { label: from.label, precise: from.precise },
    to: { label: to.label, precise: to.precise },
    approximate: !from.precise || !to.precise,
  };
}
