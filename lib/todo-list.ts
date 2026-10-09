/**
 * Pure logic behind the office "To-do list" — jobs office has set aside to
 * drop into a schedule gap. Lives on jobs.todo_listed_at / estimated_hours;
 * a database trigger takes a job off the list once it is scheduled.
 *
 * HOURS ONLY. The fallback reads purchase_orders.total_hours (via the
 * money-free purchase_orders_public view); nothing here takes or returns a
 * value/amount column.
 */

/** Statuses a job may be put on the list from. The trigger refuses the rest. */
export const TODO_LISTABLE_STATUSES = ["pending", "on_hold"] as const;

/** Upper bound matches the jobs_estimated_hours_range check constraint. */
export const MAX_ESTIMATED_HOURS = 1000;

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function isTodoListable(status: string | null | undefined): boolean {
  return (TODO_LISTABLE_STATUSES as readonly string[]).includes(status ?? "");
}

export type TodoHoursSource = "estimate" | "po" | null;

/**
 * The hours a to-do job is expected to take: office's own estimate when set,
 * else the PO allocation, else unknown. A PO allocation of 0 means nothing was
 * allocated, so it counts as unknown rather than as a zero-hour job that
 * would fit every gap.
 */
export function todoHours(
  estimatedHours: number | string | null | undefined,
  poAllocatedHours: number | null | undefined
): { hours: number | null; source: TodoHoursSource } {
  if (estimatedHours !== null && estimatedHours !== undefined && estimatedHours !== "") {
    const n = Number(estimatedHours);
    if (Number.isFinite(n) && n >= 0) return { hours: n, source: "estimate" };
  }
  if (poAllocatedHours !== null && poAllocatedHours !== undefined && poAllocatedHours > 0) {
    return { hours: poAllocatedHours, source: "po" };
  }
  return { hours: null, source: null };
}

/**
 * Whether a job fits a gap. No gap entered means no filter. A job with no
 * estimate stays visible — hiding it would make unestimated work invisible
 * exactly when office is looking for something to fill the hole.
 */
export function fitsGap(hours: number | null, gapHours: number | null): boolean {
  if (gapHours === null) return true;
  if (hours === null) return true;
  return hours <= gapHours;
}

/** Parses the "Fits in [__] h" box. Blank or unparseable means no filter. */
export function parseGapHours(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parses the estimate typed when listing a job. Blank -> null (no estimate);
 * a number outside 0..MAX_ESTIMATED_HOURS -> "invalid" so the caller can say
 * so instead of letting the check constraint reject it.
 */
export function parseEstimatedHours(input: string): number | null | "invalid" {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > MAX_ESTIMATED_HOURS) return "invalid";
  return Math.round(n * 100) / 100;
}

/**
 * Whole days a job has sat on the list. Clamped at 0: the stamp is the
 * database's now(), the comparison is the browser's clock, and a browser
 * running slow must not render "-1 days".
 */
export function daysOnList(listedAt: string, nowMs: number): number {
  const t = new Date(listedAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}

export interface TodoSortable {
  priority: string | null;
  todo_listed_at: string;
}

/** Most urgent first; within a priority, longest-waiting first. Unknown priorities sort as normal. */
export function compareTodoJobs(a: TodoSortable, b: TodoSortable): number {
  const pa = PRIORITY_RANK[a.priority ?? ""] ?? PRIORITY_RANK.normal;
  const pb = PRIORITY_RANK[b.priority ?? ""] ?? PRIORITY_RANK.normal;
  if (pa !== pb) return pa - pb;
  return new Date(a.todo_listed_at).getTime() - new Date(b.todo_listed_at).getTime();
}

export function sortTodoJobs<T extends TodoSortable>(jobs: readonly T[]): T[] {
  return [...jobs].sort(compareTodoJobs);
}

/** Sums PO allocated hours per job id. Rows are { job_id, total_hours }. */
export function allocatedHoursByJob(
  rows: readonly { job_id: string | null; total_hours: number | string | null }[]
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.job_id) continue;
    out.set(r.job_id, (out.get(r.job_id) ?? 0) + (Number(r.total_hours) || 0));
  }
  return out;
}

/** "2.5h", "8h" — trims trailing zeros. */
export function formatHours(hours: number): string {
  return `${Number(hours.toFixed(2))}h`;
}
