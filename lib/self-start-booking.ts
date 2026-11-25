// A technician starts work on a job they're not booked on (Justin, 25 Nov
// 2026): "search the job, clock onto it … we need it to show up in schedule".
// The booking is made by self_start_job_booking() (migration 0118) and then
// follows their clock: its start is the clock-on, its end the clock-off.
//
// Pure, names and ids only — never an amount (technicians use this). Mirrored
// byte for byte from the imports on at mobile/lib/selfStartBooking.ts
// (pinned by tests/unit/self-start-booking.test.ts): change this file first.
import { dateKeyInBusinessTZ, fromBusinessInputValue } from "./date";
import { businessDayRange, DEFAULT_SHIFT_END_TIME } from "./scheduling";

/** One of the job's stages (a builder PO line), as the picker shows it. */
export interface StartStage {
  id: string;
  name: string;
  /** The company cost centre the line is tagged with, when it is. */
  costCentre: string | null;
  completedAt: string | null;
}

/** The tag on a self-started booking, on the web board and the phone's Schedule tab. */
export const ADDED_BY_TECHNICIAN = "Added by technician";

export const NO_OPEN_STAGES =
  "This job has no open cost centre to clock on to. Ask the office to add one before you start.";

export const PICK_A_STAGE_TO_START = "Pick the cost centre you're working on.";

/** The stages a technician may start on: the open ones, in the job's order. Completed stages are never offered. */
export function openStartStages<S extends StartStage>(stages: S[] | null | undefined): S[] {
  return (stages ?? []).filter((s) => !s.completedAt);
}

/**
 * Which stage starts selected: the only open one, or none. With two or more
 * open, nothing is preselected — they must tap the one they're working on
 * ("it is also critical that they clock on to the correct cost centre").
 */
export function preselectedStartStage(stages: StartStage[] | null | undefined): string | null {
  const open = openStartStages(stages);
  return open.length === 1 ? open[0].id : null;
}

/** "Drainage", or "Stage 2 (Drainage)" when the line is named apart from its company cost centre. */
export function startStageLabel(stage: Pick<StartStage, "name" | "costCentre">): string {
  const name = stage.name.trim();
  const cc = (stage.costCentre ?? "").trim();
  if (!cc || cc.toLowerCase() === name.toLowerCase()) return name || cc || "Cost centre";
  return name ? `${name} (${cc})` : cc;
}

/** The confirm question: "Clock on to #123 — Drainage?" */
export function startWorkQuestion(jobNumber: number | string | null | undefined, stage: Pick<StartStage, "name" | "costCentre">): string {
  const job = jobNumber == null || jobNumber === "" ? "this job" : `#${jobNumber}`;
  return `Clock on to ${job} — ${startStageLabel(stage)}?`;
}

/** Null when the pick can be started, else the sentence to show. */
export function startStageProblem(stages: StartStage[] | null | undefined, pickedId: string | null | undefined): string | null {
  const open = openStartStages(stages);
  if (open.length === 0) return NO_OPEN_STAGES;
  if (!pickedId || !open.some((s) => s.id === pickedId)) return PICK_A_STAGE_TO_START;
  return null;
}

/** What the boards need of a booking to tag it. */
export interface TaggableBooking {
  staff_id: string | null;
  created_by?: string | null;
}

/**
 * "Added by technician": a technician booked THEMSELVES. Only
 * self_start_job_booking() (0118) does that — office bookings carry the
 * office user as created_by, and job_bookings is office-written by RLS.
 * `roleOf` answers a profile's role; an unknown creator is not tagged.
 */
export function isAddedByTechnician(b: TaggableBooking, roleOf: (id: string) => string | null | undefined): boolean {
  if (!b.created_by || !b.staff_id || b.created_by !== b.staff_id) return false;
  return roleOf(b.created_by) === "technician";
}

const MIN_RUNNING_MS = 30 * 60 * 1000;

/**
 * Where the boards draw the end of a self-started booking that is still
 * running (no clock-off yet): now, but at least to 15:30 on its day, and
 * never past the end of that day — so a forgotten clock-off doesn't paint the
 * whole week. At least half an hour, so a fresh one is visible.
 */
export function runningBookingEnd(startsAtIso: string, nowMs: number): string {
  const startMs = Date.parse(startsAtIso);
  const dayKey = dateKeyInBusinessTZ(startsAtIso);
  const shiftEndMs = Date.parse(fromBusinessInputValue(`${dayKey}T${DEFAULT_SHIFT_END_TIME}`));
  const dayEndMs = Date.parse(businessDayRange(dayKey).dayEndIso) - 60_000;
  let end = Math.max(shiftEndMs, Math.min(nowMs, dayEndMs));
  end = Math.max(end, Math.min(startMs + MIN_RUNNING_MS, dayEndMs));
  if (end <= startMs) end = startMs + 60_000;
  return new Date(end).toISOString();
}

/**
 * The bookings as the boards draw them: a self-started booking with no end
 * yet ends at runningBookingEnd() and is marked `running`. Nothing is
 * written — the clock-off sets the real end (0118's trigger).
 */
export function withRunningEnds<B extends TaggableBooking & { starts_at: string; ends_at: string | null; daily: boolean }>(
  bookings: B[],
  roleOf: (id: string) => string | null | undefined,
  nowMs: number
): (B & { running?: boolean })[] {
  return bookings.map((b) =>
    b.ends_at === null && !b.daily && isAddedByTechnician(b, roleOf)
      ? { ...b, ends_at: runningBookingEnd(b.starts_at, nowMs), running: true }
      : b
  );
}
