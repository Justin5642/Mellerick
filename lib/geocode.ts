// Address → coordinates, via OpenStreetMap's Nominatim (no key, 1 req/sec).
//
// Shared by /api/geocode (the "Add site" dialog), the hourly
// /api/sites/geocode-missing job and scripts/geocode-sites.mjs (which keeps a
// plain-JS copy of siteAddress/isPreciseEnough — keep them in step).
//
// PRECISION MATTERS MORE THAN COVERAGE. These coordinates drive the auto
// clock-in geofence (150 m). A suburb- or street-level guess puts the fence in
// the wrong place, so technicians would be clocked in and out at the wrong
// spot — worse than no fence at all. Only results Nominatim places at a
// building, house or address point are accepted; anything vaguer is "not
// found", and the job page says the site has no map location.

export const NOMINATIM_USER_AGENT = "MellerickApp/1.0 (plumbing-management)";

export interface SiteAddressParts {
  address_line1?: string | null;
  address_line2?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
}

/** "12 Smith St, Epping VIC 3076, Australia" — unit prefixes ("Unit 3/", "3/") dropped. */
export function siteAddress(s: SiteAddressParts): string | null {
  const line1 = (s.address_line1 ?? "")
    .trim()
    .replace(/^(unit|u|shop|suite|lot)\s*\d+[a-z]?\s*[/,]?\s*/i, "")
    .replace(/^\d+[a-z]?\s*\/\s*/i, "");
  if (!line1) return null;
  const locality = [s.suburb, s.state, s.postcode].map((p) => (p ?? "").trim()).filter(Boolean).join(" ");
  return [line1, locality, "Australia"].filter(Boolean).join(", ");
}

/** Nominatim result classes precise enough for a 150 m geofence. */
const PRECISE_TYPES = new Set(["house", "building", "residential", "apartments", "detached", "semidetached_house", "terrace", "commercial", "industrial", "retail", "office", "warehouse", "yes"]);

export function isPreciseEnough(result: { class?: string; type?: string; addresstype?: string }): boolean {
  if (result.addresstype && ["house", "building", "place"].includes(result.addresstype)) return true;
  if (result.class === "building") return true;
  if (result.class === "place" && result.type === "house") return true;
  // class=landuse with type residential/commercial/industrial is a ZONE — a
  // whole estate's centroid, often hundreds of metres from the house — not a
  // building (Stage 5, 31 Oct 2026). It used to pass on its type alone.
  return (
    !!result.type &&
    PRECISE_TYPES.has(result.type) &&
    result.class !== "highway" &&
    result.class !== "boundary" &&
    result.class !== "landuse"
  );
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  display: string;
  /** Building/address-level — safe for a geofence. Always true unless `approx`. */
  precise: boolean;
}

/**
 * The address's coordinates, or null when Nominatim cannot place it precisely.
 * `approx: true` also returns a street/suburb match (precise: false) — ONLY for
 * centring a map, never to save as a site location. Throws on network/HTTP failure.
 */
export async function geocodeAddress(
  address: string,
  opts: { signal?: AbortSignal; approx?: boolean } = {}
): Promise<GeocodeResult | null> {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=jsonv2&limit=1&countrycodes=au`,
    { headers: { "User-Agent": NOMINATIM_USER_AGENT }, signal: opts.signal }
  );
  if (!res.ok) throw new Error(`Nominatim answered ${res.status}`);
  const data = (await res.json()) as { lat: string; lon: string; display_name: string; class?: string; type?: string; addresstype?: string }[];
  const top = data[0];
  if (!top) return null;
  const precise = isPreciseEnough(top);
  if (!precise && !opts.approx) return null;
  return { lat: parseFloat(top.lat), lng: parseFloat(top.lon), display: top.display_name, precise };
}

// ── Address search for the "Set location on map" dialog ─────────────────────
//
// A PERSON picks from these and then sees the pin on the map before saving, so
// street- and suburb-level matches are shown too — labelled approximate, so
// they click the exact house or lot themselves. The automatic geocoders above
// (cron, script, Add site) keep accepting building-level matches only.
//
// Nominatim's usage policy forbids search-as-you-type, so the dialog searches
// only when asked (Enter or the Search button).

export interface AddressSuggestion {
  lat: number;
  lng: number;
  /** Nominatim's full display name. */
  display: string;
  /** The first parts of it — "12 Smith Street, Epping, Melbourne". */
  label: string;
  /** Building/address-level. false = street or suburb: click the exact spot. */
  precise: boolean;
}

export const ADDRESS_SEARCH_LIMIT = 6;
export const ADDRESS_SEARCH_MAX_LENGTH = 200;

type NominatimRow = { lat?: string; lon?: string; display_name?: string; class?: string; type?: string; addresstype?: string };

/** Nominatim rows → suggestions: unplaceable rows and near-duplicates (same point to ~10 m) dropped, precise first, at most `limit`. */
export function shapeAddressSuggestions(rows: readonly NominatimRow[], limit = ADDRESS_SEARCH_LIMIT): AddressSuggestion[] {
  const out: AddressSuggestion[] = [];
  for (const r of rows) {
    const lat = Number(r.lat);
    const lng = Number(r.lon);
    if (r.lat == null || r.lon == null || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const display = (r.display_name ?? "").trim();
    if (!display) continue;
    if (out.some((o) => Math.abs(o.lat - lat) < 1e-4 && Math.abs(o.lng - lng) < 1e-4)) continue;
    const parts = display.split(",").map((p) => p.trim()).filter(Boolean);
    // "12, Smith Street, …" → "12 Smith Street, …" (Nominatim splits the house number off).
    if (parts.length > 1 && /^\d+[a-z]?(?:[-/]\d+[a-z]?)?$/i.test(parts[0])) parts.splice(0, 2, `${parts[0]} ${parts[1]}`);
    out.push({ lat, lng, display, label: parts.slice(0, 3).join(", "), precise: isPreciseEnough(r) });
  }
  // Stable: precise matches first, Nominatim's own order within each group.
  return [...out.filter((o) => o.precise), ...out.filter((o) => !o.precise)].slice(0, limit);
}

/** Up to ADDRESS_SEARCH_LIMIT Australian matches for a typed address, precise or not. Throws on network/HTTP failure. */
export async function searchAddresses(query: string, opts: { signal?: AbortSignal } = {}): Promise<AddressSuggestion[]> {
  const q = query.trim().slice(0, ADDRESS_SEARCH_MAX_LENGTH);
  if (!q) return [];
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=${ADDRESS_SEARCH_LIMIT + 4}&countrycodes=au`,
    { headers: { "User-Agent": NOMINATIM_USER_AGENT }, signal: opts.signal }
  );
  if (!res.ok) throw new Error(`Nominatim answered ${res.status}`);
  const data = (await res.json()) as unknown;
  return shapeAddressSuggestions(Array.isArray(data) ? (data as NominatimRow[]) : []);
}
