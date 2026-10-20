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
  return !!result.type && PRECISE_TYPES.has(result.type) && result.class !== "highway" && result.class !== "boundary";
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  display: string;
}

/** The address's coordinates, or null when Nominatim cannot place it precisely. Throws on network/HTTP failure. */
export async function geocodeAddress(address: string, opts: { signal?: AbortSignal } = {}): Promise<GeocodeResult | null> {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=jsonv2&limit=1&countrycodes=au`,
    { headers: { "User-Agent": NOMINATIM_USER_AGENT }, signal: opts.signal }
  );
  if (!res.ok) throw new Error(`Nominatim answered ${res.status}`);
  const data = (await res.json()) as { lat: string; lon: string; display_name: string; class?: string; type?: string; addresstype?: string }[];
  const top = data[0];
  if (!top || !isPreciseEnough(top)) return null;
  return { lat: parseFloat(top.lat), lng: parseFloat(top.lon), display: top.display_name };
}
