// When a fleet item's next service is due, from its service records (0099).
//
// Pure. Without a live meter the due date is the only thing checkable: km
// and engine-hours targets are shown alongside, with the latest reading on
// record, so the office can judge them — but they never mark an item overdue
// on their own, because the reading on record is only as recent as the last
// service.
//
// With a LIVE hour meter (Komtrax, 0113 — `live`), the engine-hours target
// counts too: the item is overdue once the meter passes it, due soon within
// DUE_SOON_HOURS, and the worse of the date and the hours decides.

export interface ServiceRecord {
  id: string;
  equipment_id: string;
  service_date: string; // YYYY-MM-DD
  service_type: string;
  odometer_km: number | null;
  engine_hours: number | string | null;
  provider?: string | null;
  work_done?: string | null;
  expense_id?: string | null;
  next_due_date: string | null;
  next_due_km: number | null;
  next_due_hours: number | string | null;
  created_at?: string;
}

export const SERVICE_TYPE_LABELS: Record<string, string> = {
  scheduled: "Scheduled service",
  repair: "Repair",
  inspection: "Inspection",
  tyres: "Tyres",
  other: "Other",
};

/** Which expense category a service's cost is logged under. */
export const SERVICE_TYPE_EXPENSE_CATEGORY: Record<string, string> = {
  scheduled: "service",
  inspection: "service",
  repair: "repair",
  tyres: "tyres",
  other: "other",
};

/** "Due soon" window. */
export const DUE_SOON_DAYS = 30;
/** "Due soon" window on a live hour meter. */
export const DUE_SOON_HOURS = 50;

/** A live hour-meter reading (Komtrax). */
export interface LiveHours {
  hours: number;
  at: string | null;
}

export type DueState = "overdue" | "due_soon" | "ok" | "no_due_date" | "none";

export interface ServiceDue {
  state: DueState;
  /** The record whose "next due" applies: the latest service. */
  latest: ServiceRecord | null;
  dueDate: string | null;
  daysUntil: number | null;
  dueKm: number | null;
  dueHours: number | null;
  /** Highest readings known — the records', or the live meter's when higher. */
  lastKm: number | null;
  lastHours: number | null;
  /** The live meter (Komtrax), when there is one. */
  liveHours: number | null;
  liveHoursAt: string | null;
  /** Engine hours left until the hours target (negative = past it); live meter only. */
  hoursUntil: number | null;
  /** Which target set `state`: the date, or the live hours. */
  dueBy: "date" | "hours" | null;
}

const toDay = (k: string) => Date.parse(`${k}T00:00:00Z`) / 86_400_000;

/** Newest first: by service date, then by when it was entered. */
export function sortRecords(records: ServiceRecord[]): ServiceRecord[] {
  return [...records].sort(
    (a, b) => b.service_date.localeCompare(a.service_date) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
  );
}

const STATE_RANK: Record<"overdue" | "due_soon" | "ok", number> = { overdue: 2, due_soon: 1, ok: 0 };

export function serviceDue(records: ServiceRecord[], today: string, live?: LiveHours | null): ServiceDue {
  const sorted = sortRecords(records);
  const latest = sorted[0] ?? null;
  // The due date/km/hours come from the newest record that SET one — not the
  // newest record. Logging tyres or a repair (no "next due") used to hide the
  // service schedule and its overdue warning (audit, 15 Nov 2026).
  const planner = sorted.find((r) => r.next_due_date || r.next_due_km != null || r.next_due_hours != null) ?? null;
  const kms = records.map((r) => r.odometer_km).filter((v): v is number => v != null);
  const hrs = records.map((r) => (r.engine_hours == null ? null : Number(r.engine_hours))).filter((v): v is number => v != null);
  const liveHours = live && Number.isFinite(live.hours) ? live.hours : null;
  if (liveHours !== null) hrs.push(liveHours);
  const dueHours = planner?.next_due_hours == null ? null : Number(planner.next_due_hours);
  const hoursUntil = dueHours !== null && liveHours !== null ? Math.round((dueHours - liveHours) * 10) / 10 : null;
  const base = {
    latest,
    dueKm: planner?.next_due_km ?? null,
    dueHours,
    lastKm: kms.length ? Math.max(...kms) : null,
    lastHours: hrs.length ? Math.max(...hrs) : null,
    liveHours,
    liveHoursAt: liveHours !== null ? live?.at ?? null : null,
    hoursUntil,
  };
  if (!latest) return { ...base, state: "none", dueDate: null, daysUntil: null, dueBy: null };
  const hoursState = hoursUntil === null ? null : hoursUntil < 0 ? "overdue" : hoursUntil <= DUE_SOON_HOURS ? "due_soon" : "ok";
  if (!planner?.next_due_date) {
    if (hoursState) return { ...base, state: hoursState, dueDate: null, daysUntil: null, dueBy: "hours" };
    return { ...base, state: "no_due_date", dueDate: null, daysUntil: null, dueBy: null };
  }
  const daysUntil = Math.round(toDay(planner.next_due_date) - toDay(today));
  const dateState = daysUntil < 0 ? "overdue" : daysUntil <= DUE_SOON_DAYS ? "due_soon" : "ok";
  // The worse of the two decides; a tie stays with the date.
  const byHours = hoursState !== null && STATE_RANK[hoursState] > STATE_RANK[dateState];
  return { ...base, state: byHours ? hoursState! : dateState, dueDate: planner.next_due_date, daysUntil, dueBy: byHours ? "hours" : "date" };
}

const engineHours = (h: number) => `${Math.round(Math.abs(h)).toLocaleString("en-AU")} engine hour${Math.round(Math.abs(h)) === 1 ? "" : "s"}`;

export function dueLabel(d: ServiceDue): string {
  if (d.dueBy === "hours" && d.hoursUntil !== null) {
    if (d.state === "overdue") return `Service overdue by ${engineHours(d.hoursUntil)}`;
    if (d.state === "due_soon") return Math.round(d.hoursUntil) === 0 ? "Service due now (engine hours)" : `Service due in ${engineHours(d.hoursUntil)}`;
    return `Next service in ${engineHours(d.hoursUntil)}`;
  }
  switch (d.state) {
    case "none":
      return "No service recorded";
    case "no_due_date":
      return "Next service not set";
    case "overdue":
      return `Service overdue by ${-d.daysUntil!} day${d.daysUntil === -1 ? "" : "s"}`;
    case "due_soon":
      return d.daysUntil === 0 ? "Service due today" : `Service due in ${d.daysUntil} day${d.daysUntil === 1 ? "" : "s"}`;
    case "ok":
      return `Next service in ${d.daysUntil} days`;
  }
}

/**
 * PostgREST's answer when equipment_service_records is not in the database yet
 * (0099 unapplied): the screens say so instead of failing the whole page.
 */
export function isServiceTableMissing(error: { code?: string | null } | null | undefined): boolean {
  return !!error && (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST200");
}

/**
 * Where a service invoice copy is stored in the `equipment-documents` bucket —
 * the same shape as the Expenses tab's receipts (`expense-receipt-` keeps it
 * under 0047's money-file rule, hidden from technicians).
 */
export function serviceInvoicePath(equipmentId: string, fileName: string, now: number): string {
  return `${equipmentId}/expense-receipt-${now}_${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}
