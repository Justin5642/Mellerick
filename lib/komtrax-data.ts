import type { SupabaseClient } from "@supabase/supabase-js";
import { dateKeyInBusinessTZ } from "@/lib/date";
import { komtraxCredentials } from "@/lib/env";
import { isKomtraxTableMissing } from "@/lib/komtrax";
import { meterDays, type MeterReadings } from "@/lib/komtrax-meter";
import type { DigestMachineFault } from "@/lib/weekly-digest";

// Reads of the Komtrax mirror (0113) shared by the Fleet pages, the phone's
// machine route, Day Works and the weekly digest. No money anywhere: hours,
// fuel litres, a position and fault codes.

export const KOMTRAX_MACHINE_COLUMNS =
  "id, make_code, model, serial, oem_name, komtrax_label, equipment_id, matched_by, hours, hours_at, lat, lng, location_at, fuel_used_cumulative, fuel_used_last24, fuel_units, fuel_used_at, fuel_remaining_pct, def_remaining_pct, idle_hours, last_seen_at";

export interface KomtraxMachine {
  id: string;
  make_code: string;
  model: string;
  serial: string;
  oem_name: string | null;
  komtrax_label: string | null;
  equipment_id: string | null;
  matched_by: "auto" | "office" | null;
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
  last_seen_at: string | null;
}

export interface KomtraxFaultView {
  id: string;
  code: string;
  severity: string | null;
  description: string | null;
  source: string | null;
  occurred_at: string;
}

const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function toKomtraxMachine(r: Record<string, unknown>): KomtraxMachine {
  return {
    id: String(r.id),
    make_code: String(r.make_code ?? ""),
    model: String(r.model ?? ""),
    serial: String(r.serial ?? ""),
    oem_name: (r.oem_name as string | null) ?? null,
    komtrax_label: (r.komtrax_label as string | null) ?? null,
    equipment_id: (r.equipment_id as string | null) ?? null,
    matched_by: (r.matched_by as KomtraxMachine["matched_by"]) ?? null,
    hours: n(r.hours),
    hours_at: (r.hours_at as string | null) ?? null,
    lat: n(r.lat),
    lng: n(r.lng),
    location_at: (r.location_at as string | null) ?? null,
    fuel_used_cumulative: n(r.fuel_used_cumulative),
    fuel_used_last24: n(r.fuel_used_last24),
    fuel_units: (r.fuel_units as string | null) ?? null,
    fuel_used_at: (r.fuel_used_at as string | null) ?? null,
    fuel_remaining_pct: n(r.fuel_remaining_pct),
    def_remaining_pct: n(r.def_remaining_pct),
    idle_hours: n(r.idle_hours),
    last_seen_at: (r.last_seen_at as string | null) ?? null,
  };
}

/** "Komtrax off" (no credentials) vs "tables not applied" vs data. */
export type KomtraxMachineLoad =
  | { connected: false; ready: boolean; machine: null; faults: [] }
  | { connected: true; ready: false; machine: null; faults: [] }
  | { connected: true; ready: true; machine: KomtraxMachine | null; faults: KomtraxFaultView[] };

/** How far back the machine page lists faults. */
export const FAULT_DAYS = 30;

/** One fleet item's Komtrax machine and its recent faults. `db` decides who may read (RLS: office/admin). */
export async function loadKomtraxForEquipment(db: SupabaseClient, equipmentId: string, now = Date.now()): Promise<KomtraxMachineLoad> {
  const connected = komtraxCredentials() !== null;
  const { data, error } = await db.from("komtrax_machines").select(KOMTRAX_MACHINE_COLUMNS).eq("equipment_id", equipmentId).maybeSingle();
  if (error) {
    if (isKomtraxTableMissing(error)) return connected ? { connected: true, ready: false, machine: null, faults: [] } : { connected: false, ready: false, machine: null, faults: [] };
    throw error;
  }
  if (!connected && !data) return { connected: false, ready: true, machine: null, faults: [] };
  const machine = data ? toKomtraxMachine(data as Record<string, unknown>) : null;
  let faults: KomtraxFaultView[] = [];
  if (machine) {
    const since = new Date(now - FAULT_DAYS * 86_400_000).toISOString();
    const { data: f, error: fErr } = await db
      .from("komtrax_faults")
      .select("id, code, severity, description, source, occurred_at")
      .eq("machine_id", machine.id)
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(25);
    if (fErr) throw fErr;
    faults = (f ?? []) as KomtraxFaultView[];
  }
  // Data already synced is still shown if the login is later removed.
  return { connected: true, ready: true, machine, faults };
}

/** Komtrax hours per fleet item, for service due. Missing table → empty. */
export async function loadKomtraxHoursByEquipment(db: SupabaseClient): Promise<Map<string, { hours: number; at: string | null }>> {
  const out = new Map<string, { hours: number; at: string | null }>();
  const { data, error } = await db.from("komtrax_machines").select("equipment_id, hours, hours_at").not("equipment_id", "is", null);
  if (error) {
    if (!isKomtraxTableMissing(error)) console.error("komtrax: hours read failed", error);
    return out;
  }
  for (const r of data ?? []) {
    const h = n(r.hours);
    if (r.equipment_id && h !== null) out.set(r.equipment_id as string, { hours: h, at: (r.hours_at as string | null) ?? null });
  }
  return out;
}

/** How many days back Day Works gets meter readings for. */
export const METER_DAYS = 62;

/**
 * Hour-meter readings by fleet item and Melbourne day, for Day Works'
 * engine-hour prefill. Read with the SERVICE ROLE (technicians can't read
 * Komtrax tables) — callers must have passed requireOnJob. Hours only.
 */
export async function loadMeterReadings(admin: SupabaseClient, now = Date.now()): Promise<MeterReadings> {
  // Never takes the Day Works tab down: a prefill is a convenience.
  try {
    return await readMeterReadings(admin, now);
  } catch (err) {
    console.error("komtrax: meter readings unavailable", err instanceof Error ? err.message : "unknown");
    return {};
  }
}

async function readMeterReadings(admin: SupabaseClient, now: number): Promise<MeterReadings> {
  const { data: machines, error } = await admin.from("komtrax_machines").select("id, equipment_id").not("equipment_id", "is", null);
  if (error) {
    if (!isKomtraxTableMissing(error)) console.error("komtrax: meter machines read failed", error);
    return {};
  }
  const equipmentByMachine = new Map((machines ?? []).map((m) => [m.id as string, m.equipment_id as string]));
  if (equipmentByMachine.size === 0) return {};
  const since = new Date(now - METER_DAYS * 86_400_000).toISOString();
  const { data: rows, error: rErr } = await admin
    .from("komtrax_hour_readings")
    .select("machine_id, read_at, hours")
    .in("machine_id", [...equipmentByMachine.keys()])
    .gte("read_at", since)
    .order("read_at")
    .limit(10_000);
  if (rErr) {
    console.error("komtrax: meter readings read failed", rErr);
    return {};
  }
  const byMachine = new Map<string, { read_at: string; hours: number | string }[]>();
  for (const r of rows ?? []) {
    const list = byMachine.get(r.machine_id as string) ?? [];
    list.push({ read_at: r.read_at as string, hours: r.hours as number | string });
    byMachine.set(r.machine_id as string, list);
  }
  const out: MeterReadings = {};
  for (const [machineId, list] of byMachine) {
    out[equipmentByMachine.get(machineId)!] = meterDays(list, (iso) => dateKeyInBusinessTZ(iso));
  }
  return out;
}

export type { DigestMachineFault };

/** Faults in the last `days`, one line per machine + code (newest first). Service role; the digest is a cron. */
export async function loadRecentFaultsForDigest(admin: SupabaseClient, days = 7, now = Date.now()): Promise<DigestMachineFault[] | null> {
  const since = new Date(now - days * 86_400_000).toISOString();
  const { data, error } = await admin
    .from("komtrax_faults")
    .select("code, severity, description, occurred_at, komtrax_machines(model, serial, equipment(name))")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(500);
  if (error) {
    if (isKomtraxTableMissing(error)) return null;
    throw error;
  }
  type Row = {
    code: string;
    severity: string | null;
    description: string | null;
    occurred_at: string;
    komtrax_machines: { model: string; serial: string; equipment: { name: string } | null } | null;
  };
  return groupFaults((data ?? []) as unknown as Row[]);
}

export function groupFaults(
  rows: { code: string; severity: string | null; description: string | null; occurred_at: string; komtrax_machines: { model: string; serial: string; equipment: { name: string } | null } | null }[]
): DigestMachineFault[] {
  const m = new Map<string, DigestMachineFault>();
  for (const r of rows) {
    const km = r.komtrax_machines;
    const machine = km?.equipment?.name ?? (km ? `${km.model} (serial ${km.serial})` : "Komatsu machine");
    const key = `${machine}|${r.code}`;
    const g = m.get(key);
    if (!g) m.set(key, { machine, code: r.code, severity: r.severity, description: r.description, lastSeen: r.occurred_at, times: 1 });
    else {
      g.times += 1;
      if (r.occurred_at > g.lastSeen) g.lastSeen = r.occurred_at;
    }
  }
  return [...m.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/** Fleet → Komtrax machines: every machine and when the sync last ran. `db` = the viewer's session (RLS). */
export async function loadKomtraxFleet(db: SupabaseClient): Promise<{
  connected: boolean;
  ready: boolean;
  machines: KomtraxMachine[];
  lastOkAt: string | null;
  lastRunAt: string | null;
}> {
  const connected = komtraxCredentials() !== null;
  const [machinesRes, stateRes] = await Promise.all([
    db.from("komtrax_machines").select(KOMTRAX_MACHINE_COLUMNS).order("model"),
    db.from("komtrax_sync_state").select("last_run_at, last_ok_at").eq("id", true).maybeSingle(),
  ]);
  if (machinesRes.error) {
    if (!isKomtraxTableMissing(machinesRes.error)) console.error("komtrax: machines read failed", machinesRes.error);
    return { connected, ready: false, machines: [], lastOkAt: null, lastRunAt: null };
  }
  return {
    connected,
    ready: true,
    machines: (machinesRes.data ?? []).map((r) => toKomtraxMachine(r as Record<string, unknown>)),
    lastOkAt: (stateRes.data?.last_ok_at as string | null) ?? null,
    lastRunAt: (stateRes.data?.last_run_at as string | null) ?? null,
  };
}
