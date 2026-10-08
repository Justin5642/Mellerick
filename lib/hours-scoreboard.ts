/**
 * Pure maths behind the technician "Hours Scoreboard" on the web job page.
 *
 * MONEY BOUNDARY (HANDOVER.md §2): this module deals in HOURS ONLY. Its inputs
 * are `total_hours` from the money-free `purchase_orders_public` view (0038) and
 * the hours/clock columns of `time_entries`. Do not add a value/amount field
 * here — the technician scoreboard renders everything this returns.
 *
 * Mirrors mobile/components/job/hours-scoreboard.tsx so the two apps agree.
 */

export interface AllocatedHoursRow {
  total_hours: number | string | null;
}

export interface ScoreboardTimeEntry {
  hours: number | string | null;
  clock_in: string | null;
  clock_out: string | null;
  entry_type?: string | null;
}

export type ScoreboardTone = "green" | "orange" | "red";

export interface HoursScoreboard {
  allocatedHours: number;
  loggedHours: number;
  /** Percent of the allocation used, capped at 100. 0 when nothing is allocated. */
  pct: number;
  remainingHours: number;
  exceeded: boolean;
  /** clock_in of an open (not yet clocked-out) work entry, if any. */
  openClockIn: string | null;
  tone: ScoreboardTone;
}

export function sumAllocatedHours(rows: readonly AllocatedHoursRow[]): number {
  return rows.reduce((sum, r) => sum + (Number(r.total_hours) || 0), 0);
}

/** Same thresholds as the office PO-tab scoreboard and the mobile card. */
export function scoreboardTone(pct: number): ScoreboardTone {
  if (pct >= 95) return "red";
  if (pct >= 75) return "orange";
  return "green";
}

export function computeHoursScoreboard(
  allocatedHours: number,
  entries: readonly ScoreboardTimeEntry[],
  nowMs: number,
): HoursScoreboard {
  // Travel time is tracked separately and does not eat into the budget.
  const work = entries.filter((e) => e.entry_type !== "travel");
  const closedHours = work
    .filter((e) => e.clock_out)
    .reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
  const open = work.find((e) => !e.clock_out && e.clock_in);
  const openClockIn = open?.clock_in ?? null;
  const liveHours = openClockIn ? Math.max(0, (nowMs - new Date(openClockIn).getTime()) / 3_600_000) : 0;
  const loggedHours = closedHours + (Number.isFinite(liveHours) ? liveHours : 0);
  const pct = allocatedHours > 0 ? Math.min((loggedHours / allocatedHours) * 100, 100) : 0;
  return {
    allocatedHours,
    loggedHours,
    pct,
    remainingHours: Math.max(0, allocatedHours - loggedHours),
    exceeded: allocatedHours > 0 && loggedHours >= allocatedHours,
    openClockIn,
    tone: scoreboardTone(pct),
  };
}
