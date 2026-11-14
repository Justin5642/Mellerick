// When a fleet item's next service is due, from its service records (0099).
//
// Pure. The due date is the only thing checkable without a live odometer:
// km and engine-hours targets are shown alongside, with the latest reading on
// record, so the office can judge them — but they never mark an item overdue
// on their own, because the reading on record is only as recent as the last
// service.

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

export type DueState = "overdue" | "due_soon" | "ok" | "no_due_date" | "none";

export interface ServiceDue {
  state: DueState;
  /** The record whose "next due" applies: the latest service. */
  latest: ServiceRecord | null;
  dueDate: string | null;
  daysUntil: number | null;
  dueKm: number | null;
  dueHours: number | null;
  /** Highest readings on any record — the most recent known. */
  lastKm: number | null;
  lastHours: number | null;
}

const toDay = (k: string) => Date.parse(`${k}T00:00:00Z`) / 86_400_000;

/** Newest first: by service date, then by when it was entered. */
export function sortRecords(records: ServiceRecord[]): ServiceRecord[] {
  return [...records].sort(
    (a, b) => b.service_date.localeCompare(a.service_date) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
  );
}

export function serviceDue(records: ServiceRecord[], today: string): ServiceDue {
  const sorted = sortRecords(records);
  const latest = sorted[0] ?? null;
  const kms = records.map((r) => r.odometer_km).filter((v): v is number => v != null);
  const hrs = records.map((r) => (r.engine_hours == null ? null : Number(r.engine_hours))).filter((v): v is number => v != null);
  const base = {
    latest,
    dueKm: latest?.next_due_km ?? null,
    dueHours: latest?.next_due_hours == null ? null : Number(latest.next_due_hours),
    lastKm: kms.length ? Math.max(...kms) : null,
    lastHours: hrs.length ? Math.max(...hrs) : null,
  };
  if (!latest) return { ...base, state: "none", dueDate: null, daysUntil: null };
  if (!latest.next_due_date) return { ...base, state: "no_due_date", dueDate: null, daysUntil: null };
  const daysUntil = Math.round(toDay(latest.next_due_date) - toDay(today));
  const state: DueState = daysUntil < 0 ? "overdue" : daysUntil <= DUE_SOON_DAYS ? "due_soon" : "ok";
  return { ...base, state, dueDate: latest.next_due_date, daysUntil };
}

export function dueLabel(d: ServiceDue): string {
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
