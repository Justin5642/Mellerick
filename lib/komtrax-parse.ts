// Reading Komatsu Komtrax's ISO 15143-3 (AEMP 2.0) answers. Pure; no network.
//
// Built from the standard and Komatsu's manual, NOT from a live answer (the
// sandbox that wrote it had no access). So it is deliberately forgiving:
//   - keys are matched ignoring case, "@" (XML attributes turned into JSON)
//     and punctuation — "SerialNumber", "serialNumber", "@SerialNumber" are one;
//   - a single object where a list is expected is treated as a list of one;
//   - a value may be a number, a numeric string, or {"#text": "…"};
//   - every data item is optional (not every machine reports every item).
// What can't be read is left null rather than guessed.

export type Json = unknown;

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

function isObj(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The first of `names` present on `obj` (case- and punctuation-insensitive). */
export function pick(obj: Json, ...names: string[]): Json {
  if (!isObj(obj)) return undefined;
  const wanted = names.map(norm);
  for (const w of wanted) {
    for (const [k, v] of Object.entries(obj)) if (norm(k) === w) return v;
  }
  return undefined;
}

/** A list from a value that may be a list, one object, or absent. */
export function asList(v: Json): Json[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Text of a scalar or {"#text": …} / {"value": …}. */
export function text(v: Json): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isObj(v)) return text(pick(v, "#text", "value", "text"));
  return null;
}

export function num(v: Json): number | null {
  const t = text(v);
  if (t === null) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** An ISO 8601 instant, normalised to UTC ISO; null if unreadable. */
export function instant(v: Json): string | null {
  const t = text(v);
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Every value under a key named `name`, at any depth (lists flattened). */
export function findAll(root: Json, name: string, depth = 0): Json[] {
  if (depth > 8) return [];
  const w = norm(name);
  const out: Json[] = [];
  if (Array.isArray(root)) {
    for (const x of root) out.push(...findAll(x, name, depth + 1));
  } else if (isObj(root)) {
    for (const [k, v] of Object.entries(root)) {
      if (norm(k) === w) out.push(...asList(v));
      else out.push(...findAll(v, name, depth + 1));
    }
  }
  return out;
}

const datetimeOf = (o: Json) => instant(pick(o, "datetime", "dateTime", "date"));

export interface KomtraxFault {
  code: string;
  severity: string | null;
  description: string | null;
  source: string | null;
  occurred_at: string;
}

export interface KomtraxSnapshot {
  make_code: string;
  model: string;
  serial: string;
  oem_name: string | null;
  komtrax_label: string | null;
  hours: number | null;
  hours_at: string | null;
  lat: number | null;
  lng: number | null;
  location_at: string | null;
  fuel_used_cumulative: number | null;
  fuel_used_last24: number | null;
  fuel_units: string | null;
  fuel_used_at: string | null;
  fuel_remaining_pct: number | null;
  def_remaining_pct: number | null;
  idle_hours: number | null;
  faults: KomtraxFault[];
}

export interface HourReading {
  read_at: string;
  hours: number;
}

/** A "Hour" value as ISO 15143-3 writes it (CumulativeOperatingHours / CumulativeIdleHours). */
function hourValue(o: Json): number | null {
  return num(pick(o, "Hour", "Hours", "value"));
}

/** A ratio/percent item (FuelRemaining, DEFRemaining): "Percent", or a 0–1 ratio. */
function percentValue(o: Json): number | null {
  const pct = num(pick(o, "Percent", "Percentage"));
  if (pct !== null) return pct >= 0 && pct <= 100 ? pct : null;
  const ratio = num(pick(o, "Ratio", "value"));
  if (ratio === null) return null;
  const p = ratio <= 1 ? ratio * 100 : ratio;
  return p >= 0 && p <= 100 ? Math.round(p * 10) / 10 : null;
}

export function parseFault(o: Json): KomtraxFault | null {
  const code = text(pick(o, "CodeIdentifier", "Code", "FaultCode"));
  const occurred_at = datetimeOf(o);
  if (!code || !occurred_at) return null;
  return {
    code,
    severity: text(pick(o, "CodeSeverity", "Severity")),
    description: text(pick(o, "CodeDescription", "Description")),
    source: text(pick(o, "CodeSource", "Source")),
    occurred_at,
  };
}

/** One equipment element of a fleet snapshot (or a single-machine snapshot). */
export function parseSnapshot(eq: Json): KomtraxSnapshot | null {
  const header = pick(eq, "EquipmentHeader") ?? eq;
  const make = text(pick(header, "MakeCode", "OEMCode")) ?? text(pick(header, "OEMName"));
  const model = text(pick(header, "Model"));
  const serial = text(pick(header, "SerialNumber", "Serial"));
  if (!make || !model || !serial) return null;

  const loc = asList(pick(eq, "Location", "Locations")).at(-1);
  const hours = asList(pick(eq, "CumulativeOperatingHours")).at(-1);
  const fuel = asList(pick(eq, "FuelUsed")).at(-1);
  const fuel24 = asList(pick(eq, "FuelUsedLast24")).at(-1);
  const fuelLeft = asList(pick(eq, "FuelRemaining", "FuelRemainingRatio")).at(-1);
  const defLeft = asList(pick(eq, "DEFRemaining", "DEFRemainingRatio")).at(-1);
  const idle = asList(pick(eq, "CumulativeIdleHours")).at(-1);

  let lat = num(pick(loc, "Latitude", "Lat"));
  let lng = num(pick(loc, "Longitude", "Lon", "Lng"));
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
    lat = null;
    lng = null;
  }
  const hoursNum = hours === undefined ? null : hourValue(hours);

  return {
    make_code: make,
    model,
    serial,
    oem_name: text(pick(header, "OEMName")),
    komtrax_label: text(pick(header, "EquipmentID", "EquipmentId")),
    hours: hoursNum !== null && hoursNum >= 0 ? hoursNum : null,
    hours_at: hoursNum !== null ? datetimeOf(hours) : null,
    lat,
    lng,
    location_at: lat !== null ? datetimeOf(loc) : null,
    fuel_used_cumulative: num(pick(fuel, "FuelConsumed", "FuelUsed")),
    fuel_used_last24: num(pick(fuel24, "FuelConsumed", "FuelUsed")),
    fuel_units: text(pick(fuel, "FuelUnits", "Units")) ?? text(pick(fuel24, "FuelUnits", "Units")),
    fuel_used_at: datetimeOf(fuel) ?? datetimeOf(fuel24),
    fuel_remaining_pct: fuelLeft === undefined ? null : percentValue(fuelLeft),
    def_remaining_pct: defLeft === undefined ? null : percentValue(defLeft),
    idle_hours: idle === undefined ? null : hourValue(idle),
    faults: [...asList(pick(eq, "FaultCode", "FaultCodes"))].flatMap((f) => {
      // A FaultCodes wrapper may hold FaultCode inside it.
      const inner = pick(f, "FaultCode");
      return (inner !== undefined ? asList(inner) : [f]).map(parseFault).filter((x): x is KomtraxFault => x !== null);
    }),
  };
}

/** A fleet snapshot page: its machines and the next page's URL (if it names one). */
export function parseFleetPage(body: Json): { machines: KomtraxSnapshot[]; next: string | null } {
  const equipment = findAll(body, "Equipment").filter((e) => isObj(e) && pick(e, "EquipmentHeader") !== undefined);
  // A single-machine answer may have the header at the top level.
  const list = equipment.length > 0 ? equipment : isObj(body) && pick(body, "EquipmentHeader") !== undefined ? [body] : [];
  const machines = list.map(parseSnapshot).filter((m): m is KomtraxSnapshot => m !== null);
  return { machines, next: nextLink(body) };
}

/** The "next" link of a paged answer, if any. */
export function nextLink(body: Json): string | null {
  for (const l of findAll(body, "Links")) {
    const rel = text(pick(l, "rel"));
    const href = text(pick(l, "href"));
    if (rel && href && rel.toLowerCase() === "next") return href;
  }
  return null;
}

/** An hour-meter time series (CumulativeOperatingHours), oldest first, duplicates dropped. */
export function parseHourSeries(body: Json): HourReading[] {
  const seen = new Map<string, number>();
  for (const o of findAll(body, "CumulativeOperatingHours")) {
    const at = datetimeOf(o);
    const h = hourValue(o);
    if (at && h !== null && h >= 0) seen.set(at, h);
  }
  return [...seen.entries()].map(([read_at, hours]) => ({ read_at, hours })).sort((a, b) => a.read_at.localeCompare(b.read_at));
}

/** A fault-code time series. Duplicates (same code, same time) dropped. */
export function parseFaultSeries(body: Json): KomtraxFault[] {
  const out = new Map<string, KomtraxFault>();
  const items = [
    ...findAll(body, "FaultCode"),
    // A "FaultCodes" list of faults (no inner FaultCode wrapper).
    ...findAll(body, "FaultCodes").filter((o) => pick(o, "FaultCode") === undefined),
  ];
  for (const o of items) {
    const f = parseFault(o);
    if (f) out.set(`${f.code}|${f.occurred_at}`, f);
  }
  return [...out.values()];
}

// ── Matching a Komtrax machine to the fleet register ───────────────────────────

export interface EquipmentForMatch {
  id: string;
  name: string | null;
  registration: string | null;
  notes: string | null;
  is_active: boolean | null;
}

const tokens = (s: string | null) => new Set((s ?? "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean));

/**
 * The fleet item whose name, registration or notes carry this serial as a
 * whole word ("PC88 – serial 12345"). The register has no serial column, so
 * this is a suggestion the office can override. Exactly one active match, or
 * none — two candidates are left for the office to choose.
 */
export function matchEquipmentBySerial(serial: string, equipment: EquipmentForMatch[], taken: Set<string> = new Set()): string | null {
  const want = serial.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (want.length < 4) return null;
  const hits = equipment.filter(
    (e) => e.is_active !== false && !taken.has(e.id) && [e.name, e.registration, e.notes].some((f) => tokens(f).has(want))
  );
  return hits.length === 1 ? hits[0].id : null;
}
