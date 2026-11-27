/**
 * The web Schedule page's List tab (27 Nov 2026, Emma): which jobs it shows,
 * and the "done?" signals beside each row so the office needn't open a job to
 * see it — the job's own completion (a green "✓ Completed" pill) and each
 * booked stage's (a ✓ when that PO line's completed_at is set, 0095).
 *
 * Pure: names, ids, date keys and statuses only — never an amount.
 */

export type ListSection = "today" | "upcoming";

/**
 * Where a job goes on the List tab, or null when it isn't listed.
 * - cancelled: never;
 * - completed: only when one of its booked days is today or later (history
 *   stays on the Week/Day board);
 * - open: whenever it has a booked day — past-dated open work stays under
 *   Upcoming, as before.
 * Today = a booked day is today.
 */
export function listSection(
  status: string,
  dayKeys: readonly string[],
  todayKey: string,
): ListSection | null {
  if (status === "cancelled" || dayKeys.length === 0) return null;
  if (dayKeys.includes(todayKey)) return "today";
  if (status === "completed" && !dayKeys.some((k) => k > todayKey)) return null;
  return "upcoming";
}

/** True when the List row is drawn greyed with the "✓ Completed" pill. */
export function isListCompleted(status: string): boolean {
  return status === "completed";
}

/** The pill beside a List row: "✓ Completed" for a completed job, else its status. */
export function listStatusLabel(status: string): string {
  if (isListCompleted(status)) return "✓ Completed";
  return status.replace(/_/g, " ");
}

export type ListStageBooking = {
  id: string;
  cost_center_id: string | null;
  cost_center_name?: string | null;
  /** po_cost_centers.completed_at (0095), via po_cost_centers_public. */
  cost_center_completed_at?: string | null;
};

export type ListStage = { id: string; name: string; done: boolean };

/**
 * The stages booked on the row's day(s): each distinct cost centre of the
 * bookings that occupy one of `dayKeys`, in booking order, ticked when that
 * stage is complete. A booking with no cost centre, or one whose name couldn't
 * be read, is left out.
 */
export function listStages(
  bookings: readonly ListStageBooking[],
  daysOf: (bookingId: string) => readonly string[],
  dayKeys: readonly string[],
): ListStage[] {
  const wanted = new Set(dayKeys);
  const seen = new Map<string, ListStage>();
  for (const b of bookings) {
    if (!b.cost_center_id || !b.cost_center_name) continue;
    if (!daysOf(b.id).some((k) => wanted.has(k))) continue;
    const done = !!b.cost_center_completed_at;
    const had = seen.get(b.cost_center_id);
    if (had) had.done = had.done || done;
    else seen.set(b.cost_center_id, { id: b.cost_center_id, name: b.cost_center_name, done });
  }
  return [...seen.values()];
}

/** "Sewer ✓ · Stormwater" — for a title attribute or plain text. */
export function listStagesLabel(stages: readonly ListStage[]): string {
  return stages.map((s) => (s.done ? `${s.name} ✓` : s.name)).join(" · ");
}
