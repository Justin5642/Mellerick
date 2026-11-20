// Display helpers for Komtrax data (0113 (draft)) on the Fleet pages. Pure.

/** A maps link for a machine's last known position. */
export function mapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

export function fuelUnitLabel(u: string | null | undefined): string {
  const s = (u ?? "").toLowerCase();
  if (!s || s.startsWith("lit")) return "L";
  if (s.startsWith("gal")) return "gal";
  return u ?? "";
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en-AU");

export function hoursText(h: number | null): string {
  return h === null ? "—" : `${n1(h)} h`;
}

export function fuelText(v: number | null, units: string | null): string {
  return v === null ? "—" : `${n1(v)} ${fuelUnitLabel(units)}`;
}

/** "3 h ago", "2 days ago" — how fresh a Komtrax reading is. */
export function ageText(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 60 * 60_000) return "under an hour ago";
  const h = Math.floor(ms / 3_600_000);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/** Severity → tone. Komtrax severities vary ("High", "1", "Caution"…), so it's a guess. */
export function severityTone(sev: string | null): "high" | "medium" | "low" {
  const s = (sev ?? "").toLowerCase();
  if (/high|critical|severe|error|stop/.test(s)) return "high";
  if (/med|warn|caution/.test(s)) return "medium";
  return "low";
}
