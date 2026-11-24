// MIRROR of the web's lib/over-hours.ts — the schedule's "Over allowed hours"
// alert (Justin, 24 Nov 2026). Used by the office Schedule tab
// (app/(office)/schedule.tsx) with the online read in lib/data/reads/overHours.ts.
//
// Everything from the first `export` on is pinned byte-identical to the web
// file by tests/unit/over-hours-mirror.test.ts. Change the web file first.
// HOURS ONLY: allowed hours from the money-free views, used hours from
// time_entries' hour/clock columns. Never an amount, rate or value.

export interface OverHoursLine {
  id: string;
  job_id: string;
  name: string | null;
  allocated_hours: number | string | null;
}

/** A builder PO's own hours total (purchase_orders_public.total_hours). */
export interface OverHoursPo {
  job_id: string;
  total_hours: number | string | null;
}

export interface OverHoursEntry {
  job_id: string;
  cost_center_id: string | null;
  hours: number | string | null;
  clock_in: string | null;
  clock_out: string | null;
  entry_type?: string | null;
}

export interface LineHours {
  name: string | null;
  usedHours: number;
  allowedHours: number;
}

export interface JobHours {
  usedHours: number;
  /** The lines' allowed hours added up, else the POs' total_hours. 0 = nothing allowed. */
  allowedHours: number;
  /** By PO line id, in line order. */
  lines: Record<string, LineHours>;
}

/** By job id. A plain object, so it passes from a server page to the board as is. */
export type HoursByJob = Record<string, JobHours>;

export interface OverHours {
  level: "line" | "job";
  jobId: string;
  /** The PO line for a line-level alert; null at job level. */
  costCenterId: string | null;
  name: string | null;
  usedHours: number;
  allowedHours: number;
  /** "Over hours: 34 h of 30 h (Drainage)" / "Over hours: 120 h of 100 h". */
  text: string;
}

const num = (v: number | string | null | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Hours to one decimal place, for display and for the over/not-over test. */
export function roundHours(hours: number): number {
  return Math.round(hours * 10) / 10;
}

export function formatOverHours(hours: number): string {
  return `${roundHours(hours)} h`;
}

/** The hours one entry counts for: travel 0, closed its hours, open the time since clock_in. */
export function entryUsedHours(entry: OverHoursEntry, nowMs: number): number {
  if (entry.entry_type === "travel") return 0;
  if (entry.clock_out) return Math.max(0, num(entry.hours));
  if (!entry.clock_in) return 0;
  const live = (nowMs - new Date(entry.clock_in).getTime()) / 3_600_000;
  return Number.isFinite(live) ? Math.max(0, live) : 0;
}

/** Each job's used and allowed hours, in total and per PO line. */
export function summariseJobHours(input: {
  pos: readonly OverHoursPo[];
  lines: readonly OverHoursLine[];
  entries: readonly OverHoursEntry[];
  nowMs: number;
}): HoursByJob {
  const jobs: HoursByJob = {};
  const jobFor = (jobId: string) => {
    let job = jobs[jobId];
    if (!job) {
      job = { usedHours: 0, allowedHours: 0, lines: {} };
      jobs[jobId] = job;
    }
    return job;
  };
  const poTotals = new Map<string, number>();
  for (const po of input.pos) poTotals.set(po.job_id, (poTotals.get(po.job_id) ?? 0) + Math.max(0, num(po.total_hours)));
  for (const line of input.lines) {
    const job = jobFor(line.job_id);
    const allowed = Math.max(0, num(line.allocated_hours));
    job.lines[line.id] = { name: line.name, usedHours: 0, allowedHours: allowed };
    job.allowedHours += allowed;
  }
  for (const [jobId, total] of poTotals) {
    const job = jobFor(jobId);
    if (job.allowedHours <= 0) job.allowedHours = total;
  }
  for (const entry of input.entries) {
    const used = entryUsedHours(entry, input.nowMs);
    if (used <= 0) continue;
    const job = jobFor(entry.job_id);
    job.usedHours += used;
    const line = entry.cost_center_id ? job.lines[entry.cost_center_id] : undefined;
    if (line) line.usedHours += used;
  }
  return jobs;
}

function isOver(used: number, allowed: number): boolean {
  return allowed > 0 && roundHours(used) > roundHours(allowed);
}

function overText(used: number, allowed: number, name: string | null): string {
  return `Over hours: ${formatOverHours(used)} of ${formatOverHours(allowed)}${name ? ` (${name})` : ""}`;
}

/** The job as a whole over its allowed hours, or null. */
export function jobLevelOverHours(jobId: string, hours: HoursByJob): OverHours | null {
  const job = hours[jobId];
  if (!job || !isOver(job.usedHours, job.allowedHours)) return null;
  return {
    level: "job",
    jobId,
    costCenterId: null,
    name: null,
    usedHours: job.usedHours,
    allowedHours: job.allowedHours,
    text: overText(job.usedHours, job.allowedHours, null),
  };
}

/** One PO line over its allowed hours, or null. */
export function lineOverHours(jobId: string, costCenterId: string | null, hours: HoursByJob): OverHours | null {
  if (!costCenterId) return null;
  const line = hours[jobId]?.lines[costCenterId];
  if (!line || !isOver(line.usedHours, line.allowedHours)) return null;
  return {
    level: "line",
    jobId,
    costCenterId,
    name: line.name,
    usedHours: line.usedHours,
    allowedHours: line.allowedHours,
    text: overText(line.usedHours, line.allowedHours, line.name),
  };
}

/**
 * A booking's alert: its own cost centre line when that line is over its
 * allowed hours, otherwise the whole job when it is over its total. Never
 * flagged when nothing is allowed.
 */
export function bookingOverHours(
  booking: { job_id: string; cost_center_id?: string | null },
  hours: HoursByJob,
): OverHours | null {
  return lineOverHours(booking.job_id, booking.cost_center_id ?? null, hours) ?? jobLevelOverHours(booking.job_id, hours);
}

/**
 * Everything over on one job: the job total first, then each line, in line
 * order. The total is left out when one over line already says the same
 * hours (a job with a single cost centre), so the list doesn't repeat itself.
 */
export function jobOverHours(jobId: string, hours: HoursByJob): OverHours[] {
  const lines: OverHours[] = [];
  for (const id of Object.keys(hours[jobId]?.lines ?? {})) {
    const line = lineOverHours(jobId, id, hours);
    if (line) lines.push(line);
  }
  const total = jobLevelOverHours(jobId, hours);
  const same = (l: OverHours) =>
    !!total && roundHours(l.usedHours) === roundHours(total.usedHours) && roundHours(l.allowedHours) === roundHours(total.allowedHours);
  return total && !lines.some(same) ? [total, ...lines] : lines;
}

/** The header's list: each of these jobs with something over, in the order given. */
export function jobsOverHours(jobIds: readonly string[], hours: HoursByJob): { jobId: string; items: OverHours[] }[] {
  const seen = new Set<string>();
  const out: { jobId: string; items: OverHours[] }[] = [];
  for (const jobId of jobIds) {
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    const items = jobOverHours(jobId, hours);
    if (items.length > 0) out.push({ jobId, items });
  }
  return out;
}

/** "1 job over its allowed hours" / "3 jobs over their allowed hours". */
export function overHoursHeadline(count: number): string {
  return count === 1 ? "1 job over its allowed hours" : `${count} jobs over their allowed hours`;
}
