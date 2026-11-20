import type { SupabaseClient } from "@supabase/supabase-js";
import { komtraxCredentials, komtraxSubscriberId } from "@/lib/env";
import {
  matchEquipmentBySerial,
  parseFaultSeries,
  parseFleetPage,
  parseHourSeries,
  type EquipmentForMatch,
  type HourReading,
  type KomtraxFault,
  type KomtraxSnapshot,
} from "@/lib/komtrax-parse";

// Komatsu Komtrax (ISO 15143-3 / AEMP 2.0) → our own tables (migration 0113).
// Read-only toward Komatsu. Run by /api/komtrax/sync (cron every 6 h; admin
// can run it by hand).
//
// RATE LIMIT (Komatsu): at most one call per URL per user every 15 minutes,
// or access may be denied. So: a run is refused outright when the previous
// one started under 15 minutes ago (the token URL is the same every run), and
// every URL's last call is kept in komtrax_sync_state.url_calls and skipped
// if it is too recent. Komtrax refreshes about every 6 hours anyway.
//
// SECRETS: KOMTRAX_USERNAME / KOMTRAX_PASSWORD are read only here, sent only
// in the token request body, and never logged or put in an error message.
// The bearer token lives in memory for the one run; it is never stored.

export const KOMTRAX_BASE = "https://isoapi.komtrax.komatsu/provider";
export const MIN_URL_GAP_MS = 15 * 60_000;
/** Total HTTP calls one run may make (token + snapshot pages + per-machine series). */
export const MAX_REQUESTS_PER_RUN = 80;
const MAX_SNAPSHOT_PAGES = 5;
const PAGE_SIZE = 100;
const RUN_BUDGET_MS = 40_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** How far back each run re-reads the hour and fault series. */
export const SERIES_DAYS = 2;

/** ISO 15143-3 data item names in the time-series URL. */
export const HOURS_ITEM = "CumulativeOperatingHours";
export const FAULT_ITEMS = ["FaultCode", "FaultCodes"] as const;

export class KomtraxTablesMissing extends Error {
  constructor() {
    super("Komtrax tables not found");
    this.name = "KomtraxTablesMissing";
  }
}

/** A Komtrax HTTP failure. The message names the step and status only — never a body or credential. */
export class KomtraxHttpError extends Error {
  constructor(readonly step: string, readonly status: number) {
    super(`Komtrax ${step} answered ${status}`);
    this.name = "KomtraxHttpError";
  }
}

const MISSING_TABLE = new Set(["42P01", "PGRST205", "PGRST200"]);
export const isKomtraxTableMissing = (e: { code?: string | null } | null | undefined) => !!e && MISSING_TABLE.has(e.code ?? "");

export type KomtraxSyncResult =
  | { skipped: true; reason: string }
  | { skipped: false; machines: number; linked: number; readings: number; faults: number; requests: number; seriesSkipped: number; seriesFailed: number };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** URLs called within the last 15 minutes (pruned of anything older). */
export function recentCalls(calls: Record<string, string> | null | undefined, now: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [url, at] of Object.entries(calls ?? {})) {
    const t = Date.parse(at);
    if (Number.isFinite(t) && now - t < MIN_URL_GAP_MS && t <= now + 60_000) out[url] = at;
  }
  return out;
}

/** The previous run started too recently for Komatsu's 15-minute rule. */
export function ranTooRecently(lastRunAt: string | null | undefined, now: number): boolean {
  if (!lastRunAt) return false;
  const t = Date.parse(lastRunAt);
  // A last run "in the future" (clock moved) doesn't block forever.
  return Number.isFinite(t) && now - t < MIN_URL_GAP_MS && t <= now + 60_000;
}

/** The time-series window: UTC midnight SERIES_DAYS ago → now (to the minute). */
export function seriesWindow(now: number): { start: string; end: string } {
  const d = new Date(now);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - SERIES_DAYS));
  const end = new Date(Math.floor(now / 60_000) * 60_000);
  const iso = (x: Date) => x.toISOString().replace(/\.\d{3}Z$/, "Z");
  return { start: iso(start), end: iso(end) };
}

const seg = (s: string) => encodeURIComponent(s);

export function fleetPageUrl(page: number, subscriber = komtraxSubscriberId()): string {
  return `${KOMTRAX_BASE}/v1/${seg(subscriber)}/Fleet/${page}`;
}

export function seriesUrl(m: { make_code: string; model: string; serial: string }, item: string, window: { start: string; end: string }, subscriber = komtraxSubscriberId()): string {
  return `${KOMTRAX_BASE}/v1/${seg(subscriber)}/Fleet/1/Equipment/MakeModelSerial/${seg(m.make_code)}/${seg(m.model)}/${seg(m.serial)}/${seg(item)}/${window.start}/${window.end}`;
}

/** One run's HTTP session: the token, the 15-minute rule, the request cap. */
export class KomtraxSession {
  private token: string | null = null;
  requests = 0;
  skipped = 0;
  readonly calls: Record<string, string>;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly creds: { userName: string; password: string },
    calls: Record<string, string>,
    private readonly now: () => number = Date.now
  ) {
    this.calls = { ...calls };
  }

  /** True when this URL may be called now (not within 15 min, under the cap). */
  canCall(url: string): boolean {
    return !this.calls[url] && this.requests < MAX_REQUESTS_PER_RUN;
  }

  private mark(url: string) {
    this.calls[url] = new Date(this.now()).toISOString();
    this.requests += 1;
  }

  async login(): Promise<void> {
    const url = `${KOMTRAX_BASE}/token`;
    if (!this.canCall(url)) throw new KomtraxHttpError("token (asked under 15 minutes ago)", 429);
    const body = new URLSearchParams({ grant_type: "password", userName: this.creds.userName, password: this.creds.password }).toString();
    this.mark(url);
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new KomtraxHttpError("token", res.status);
    const json = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
    if (!json || typeof json.access_token !== "string" || !json.access_token) throw new KomtraxHttpError("token (no access_token)", res.status);
    this.token = json.access_token;
  }

  /** GET a JSON answer. null = skipped by the 15-minute rule or the cap; 404 → {notFound}. */
  async get(url: string): Promise<{ notFound: true } | { body: unknown } | null> {
    if (!this.token) throw new Error("Komtrax: not logged in");
    if (!this.canCall(url)) {
      this.skipped += 1;
      return null;
    }
    this.mark(url);
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404 || res.status === 204) return { notFound: true };
    if (!res.ok) throw new KomtraxHttpError("data request", res.status);
    const txt = await res.text();
    if (!txt.trim()) return { notFound: true };
    try {
      return { body: JSON.parse(txt) };
    } catch {
      // XML (the API can answer either) — Accept: application/json should prevent it.
      throw new KomtraxHttpError("data request (not JSON)", res.status);
    }
  }
}

function snapshotRow(m: KomtraxSnapshot, nowIso: string) {
  return {
    make_code: m.make_code,
    model: m.model,
    serial: m.serial,
    oem_name: m.oem_name,
    komtrax_label: m.komtrax_label,
    hours: m.hours,
    hours_at: m.hours_at,
    lat: m.lat,
    lng: m.lng,
    location_at: m.location_at,
    fuel_used_cumulative: m.fuel_used_cumulative,
    fuel_used_last24: m.fuel_used_last24,
    fuel_units: m.fuel_units,
    fuel_used_at: m.fuel_used_at,
    fuel_remaining_pct: m.fuel_remaining_pct,
    def_remaining_pct: m.def_remaining_pct,
    idle_hours: m.idle_hours,
    last_seen_at: nowIso,
    updated_at: nowIso,
  };
}

interface MachineRow {
  id: string;
  make_code: string;
  model: string;
  serial: string;
  equipment_id: string | null;
  matched_by: string | null;
  hours: number | string | null;
  hours_at: string | null;
}

/** Bump state.url_calls etc. Separate so a failed run still records its calls. */
async function saveState(admin: SupabaseClient, patch: Record<string, unknown>) {
  const { error } = await admin.from("komtrax_sync_state").upsert({ id: true, ...patch }, { onConflict: "id" });
  if (error) console.error("komtrax: sync state not saved", error);
}

export async function syncKomtrax(
  admin: SupabaseClient,
  opts: { fetchImpl?: FetchLike; now?: () => number } = {}
): Promise<KomtraxSyncResult> {
  const creds = komtraxCredentials();
  if (!creds) return { skipped: true, reason: "Komtrax not connected" };
  const now = opts.now ?? Date.now;
  const started = now();

  const { data: state, error: stateError } = await admin
    .from("komtrax_sync_state")
    .select("last_run_at, url_calls")
    .eq("id", true)
    .maybeSingle();
  if (stateError) {
    if (isKomtraxTableMissing(stateError)) throw new KomtraxTablesMissing();
    throw stateError;
  }
  if (ranTooRecently(state?.last_run_at, started)) {
    return { skipped: true, reason: "Komtrax was read less than 15 minutes ago" };
  }

  const session = new KomtraxSession(opts.fetchImpl ?? ((u, i) => fetch(u, i)), creds, recentCalls(state?.url_calls as Record<string, string> | null, started), now);
  // Claim the run first, so an overlapping run (cron + a manual press) backs off.
  await saveState(admin, { last_run_at: new Date(started).toISOString() });

  try {
    await session.login();

    // 1. Snapshot of every machine, paged.
    const snapshots: KomtraxSnapshot[] = [];
    let url: string | null = fleetPageUrl(1);
    for (let page = 1; url && page <= MAX_SNAPSHOT_PAGES; page++) {
      const got = await session.get(url);
      if (!got || "notFound" in got) break;
      const parsed = parseFleetPage(got.body);
      snapshots.push(...parsed.machines);
      const nextUrl = parsed.next && parsed.next.startsWith(KOMTRAX_BASE) ? parsed.next : parsed.next?.startsWith("/") ? `${new URL(KOMTRAX_BASE).origin}${parsed.next}` : null;
      url = nextUrl ?? (parsed.machines.length >= PAGE_SIZE ? fleetPageUrl(page + 1) : null);
    }
    const nowIso = new Date(now()).toISOString();

    // De-duplicate (a machine can appear on two pages while Komtrax repages).
    const byKey = new Map<string, KomtraxSnapshot>();
    for (const s of snapshots) byKey.set(`${s.make_code}|${s.model}|${s.serial}`, s);
    const unique = [...byKey.values()];

    // One machine at a time, without its missing items: a snapshot that left
    // out (say) Location must not wipe the last known position.
    for (const s of unique) {
      const row = Object.fromEntries(Object.entries(snapshotRow(s, nowIso)).filter(([, v]) => v !== null));
      const { error } = await admin.from("komtrax_machines").upsert(row, { onConflict: "make_code,model,serial" });
      if (error) throw error;
    }

    const { data: machineRows, error: machinesError } = await admin
      .from("komtrax_machines")
      .select("id, make_code, model, serial, equipment_id, matched_by, hours, hours_at");
    if (machinesError) throw machinesError;
    const machines = (machineRows ?? []) as MachineRow[];
    const idByKey = new Map(machines.map((m) => [`${m.make_code}|${m.model}|${m.serial}`, m.id]));

    // 2. Link new machines to the fleet register by serial (never over the office's choice).
    let linked = 0;
    const unlinked = machines.filter((m) => !m.equipment_id && !m.matched_by);
    if (unlinked.length > 0) {
      const { data: eq, error: eqError } = await admin.from("equipment").select("id, name, registration, notes, is_active");
      if (eqError) throw eqError;
      const taken = new Set(machines.map((m) => m.equipment_id).filter((x): x is string => !!x));
      for (const m of unlinked) {
        const match = matchEquipmentBySerial(m.serial, (eq ?? []) as EquipmentForMatch[], taken);
        if (!match) continue;
        const { error } = await admin.from("komtrax_machines").update({ equipment_id: match, matched_by: "auto" }).eq("id", m.id).is("equipment_id", null);
        if (error) {
          console.error("komtrax: auto-link failed", error);
          continue;
        }
        taken.add(match);
        linked += 1;
      }
    }

    // 3. Readings and faults: the snapshot's own, then each machine's last two days.
    const readings: { machine_id: string; read_at: string; hours: number }[] = [];
    const faults: ({ machine_id: string } & KomtraxFault)[] = [];
    for (const s of unique) {
      const id = idByKey.get(`${s.make_code}|${s.model}|${s.serial}`);
      if (!id) continue;
      if (s.hours !== null && s.hours_at) readings.push({ machine_id: id, read_at: s.hours_at, hours: s.hours });
      for (const f of s.faults) faults.push({ machine_id: id, ...f });
    }

    const window = seriesWindow(started);
    let seriesFailed = 0;
    for (const m of machines) {
      if (!byKey.has(`${m.make_code}|${m.model}|${m.serial}`)) continue; // not in this run's snapshot
      if (now() - started > RUN_BUDGET_MS) break;
      try {
        const hoursRes = await session.get(seriesUrl(m, HOURS_ITEM, window));
        if (hoursRes && "body" in hoursRes) {
          for (const r of parseHourSeries(hoursRes.body)) readings.push({ machine_id: m.id, ...r });
        }
        for (const item of FAULT_ITEMS) {
          const faultRes = await session.get(seriesUrl(m, item, window));
          if (!faultRes) break; // rate rule / cap
          if ("notFound" in faultRes) continue; // try the other spelling
          for (const f of parseFaultSeries(faultRes.body)) faults.push({ machine_id: m.id, ...f });
          break;
        }
      } catch (err) {
        seriesFailed += 1;
        console.error("komtrax: series read failed", err instanceof Error ? err.message : "unknown");
      }
    }

    const uniqReadings = dedupe(readings, (r) => `${r.machine_id}|${r.read_at}`);
    if (uniqReadings.length > 0) {
      const { error } = await admin.from("komtrax_hour_readings").upsert(uniqReadings, { onConflict: "machine_id,read_at", ignoreDuplicates: true });
      if (error) throw error;
    }
    const uniqFaults = dedupe(faults, (f) => `${f.machine_id}|${f.code}|${f.occurred_at}`);
    if (uniqFaults.length > 0) {
      const { error } = await admin.from("komtrax_faults").upsert(uniqFaults, { onConflict: "machine_id,code,occurred_at", ignoreDuplicates: true });
      if (error) throw error;
    }

    // A series reading newer than the snapshot's becomes the machine's hours.
    for (const m of machines) {
      const latest = latestReading(uniqReadings.filter((r) => r.machine_id === m.id));
      if (!latest) continue;
      if (m.hours_at && Date.parse(m.hours_at) >= Date.parse(latest.read_at)) continue;
      const { error } = await admin.from("komtrax_machines").update({ hours: latest.hours, hours_at: latest.read_at }).eq("id", m.id);
      if (error) console.error("komtrax: hours update failed", error);
    }

    await saveState(admin, {
      last_ok_at: new Date(now()).toISOString(),
      last_error: null,
      last_machines: unique.length,
      last_requests: session.requests,
      url_calls: session.calls,
    });
    return {
      skipped: false,
      machines: unique.length,
      linked,
      readings: uniqReadings.length,
      faults: uniqFaults.length,
      requests: session.requests,
      seriesSkipped: session.skipped,
      seriesFailed,
    };
  } catch (err) {
    await saveState(admin, {
      last_error: (err instanceof Error ? err.message : "Komtrax sync failed").slice(0, 500),
      last_requests: session.requests,
      url_calls: session.calls,
    });
    throw err;
  }
}

function dedupe<T>(rows: T[], key: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r);
  return [...m.values()];
}

export function latestReading(rows: HourReading[]): HourReading | null {
  let best: HourReading | null = null;
  for (const r of rows) if (!best || r.read_at > best.read_at) best = r;
  return best;
}
