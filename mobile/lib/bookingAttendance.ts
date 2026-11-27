// MIRROR of the web's lib/booking-attendance.ts — "Didn't make it" and "Not
// attended" on a booking (Justin, 27 Nov 2026; migration 0121). Identical
// below the imports, pinned by tests/unit/booking-attendance-mirror.test.ts:
// change the web file first, then copy its body here.
//
// No money anywhere: reasons, notes, days and ids only.
import { dateKeyInBusinessTZ } from "./date";
import { scheduleDays } from "./scheduling";

/** 0121's job_bookings_missed_reason check, in the order the sheet lists them. */
export const MISSED_REASONS = [
  { key: "out_of_time", label: "Ran out of time" },
  { key: "previous_job_ran_over", label: "Previous job ran over" },
  { key: "site_not_ready", label: "Site not ready / no access" },
  { key: "weather", label: "Weather" },
  { key: "unavailable", label: "Sick / unavailable" },
  { key: "other", label: "Other" },
] as const;

export type MissedReason = (typeof MISSED_REASONS)[number]["key"];

/** 0121's job_bookings_missed_note_length. */
export const MISSED_NOTE_MAX = 500;

export const DIDNT_MAKE_IT = "Didn't make it";
export const NOT_ATTENDED = "Not attended";

/** The booking columns 0121 adds that every reader shows (missed_by stays on the server). */
export const MISSED_COLUMNS = "missed_at, missed_reason, missed_note";

export function isMissedReason(value: unknown): value is MissedReason {
  return typeof value === "string" && MISSED_REASONS.some((r) => r.key === value);
}

/** "Weather"; an unknown key (a newer reason list) reads "Other". */
export function missedReasonLabel(reason: string | null | undefined): string {
  return MISSED_REASONS.find((r) => r.key === reason)?.label ?? "Other";
}

/** What a booking row carries of the flag (all null = not flagged). */
export interface MissedFields {
  missed_at?: string | null;
  missed_reason?: string | null;
  missed_note?: string | null;
}

export function isMissed(b: MissedFields): boolean {
  return !!b.missed_reason;
}

/** "Didn't make it — Weather" (the note, when there is one, goes on hover / in the sheet). */
export function missedTagText(b: MissedFields): string {
  return `${DIDNT_MAKE_IT} — ${missedReasonLabel(b.missed_reason)}`;
}

/** The whole sentence: "Didn't make it — Other: truck broke down". */
export function missedDetailText(b: MissedFields): string {
  const note = (b.missed_note ?? "").trim();
  return note ? `${missedTagText(b)}: ${note}` : missedTagText(b);
}

export type MissedInput = { ok: true; reason: MissedReason; note: string | null } | { ok: false; error: string };

/** The sheet's / route's check — the same rules as 0121's constraints. */
export function validateMissed(input: { reason?: unknown; note?: unknown }): MissedInput {
  if (!isMissedReason(input.reason)) return { ok: false, error: "Pick a reason." };
  if (input.note != null && typeof input.note !== "string") return { ok: false, error: "The note must be text." };
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > MISSED_NOTE_MAX) return { ok: false, error: `Keep the note to ${MISSED_NOTE_MAX} characters.` };
  if (input.reason === "other" && !note) return { ok: false, error: "Say what happened (Other needs a note)." };
  return { ok: true, reason: input.reason, note: note || null };
}

/** What the day rules need of a booking. */
export interface AttendanceBooking extends MissedFields {
  id: string;
  job_id: string;
  staff_id: string | null;
  starts_at: string;
  ends_at: string | null;
  daily: boolean;
  all_day?: boolean;
}

/** The Melbourne days a booking occupies (0071/0079 rules — never starts_at alone). */
export function bookedDayKeys(b: Pick<AttendanceBooking, "starts_at" | "ends_at" | "daily">): string[] {
  return scheduleDays({ scheduled_start: b.starts_at, scheduled_end: b.ends_at, schedule_daily: b.daily }).map((d) => d.dateKey);
}

/** Completed and cancelled jobs are closed (0096). */
export function isClosedJobStatus(status: string | null | undefined): boolean {
  return status === "completed" || status === "cancelled";
}

/**
 * Whether "Didn't make it" is offered on this booking: someone's booking (not
 * Unassigned) on an open job, whose first booked day is today or earlier —
 * a future booking can't be missed yet. 0121's flag_booking_missed() decides
 * again on the server.
 */
export function canFlagMissed(b: Pick<AttendanceBooking, "staff_id" | "starts_at" | "ends_at" | "daily">, jobStatus: string | null | undefined, todayKey: string): boolean {
  if (!b.staff_id || isClosedJobStatus(jobStatus)) return false;
  const days = bookedDayKeys(b);
  const first = days[0] ?? dateKeyInBusinessTZ(b.starts_at);
  return first <= todayKey;
}

/** A WORK time entry, as much of it as the rule reads (no hours, no rate). */
export interface AttendanceEntry {
  job_id: string | null;
  staff_id: string | null;
  clock_in: string | null;
  entry_type?: string | null;
}

/** "staff|job|day" for every work entry's clock-on (Melbourne day). */
export function attendedKeys(entries: readonly AttendanceEntry[]): Set<string> {
  const keys = new Set<string>();
  for (const e of entries) {
    if (!e.job_id || !e.staff_id || !e.clock_in) continue;
    if (e.entry_type && e.entry_type !== "work") continue;
    keys.add(`${e.staff_id}|${e.job_id}|${dateKeyInBusinessTZ(e.clock_in)}`);
  }
  return keys;
}

export interface AttendanceWindow {
  /** Today, Melbourne. Only bookings whose LAST booked day is before it count. */
  todayKey: string;
  /**
   * The first day the time entries were read for. A booking that starts
   * before it is never called "not attended" — its earlier days weren't read.
   */
  fromKey: string;
}

/**
 * "Not attended": the booking's last booked day is before today, its job is
 * open, it isn't flagged "Didn't make it", and its technician has no WORK
 * entry on that job clocked on on any of its booked days. Computed, never
 * written.
 */
export function isNotAttended(
  b: AttendanceBooking,
  jobStatus: string | null | undefined,
  attended: ReadonlySet<string>,
  window: AttendanceWindow,
): boolean {
  if (!b.staff_id || isMissed(b) || isClosedJobStatus(jobStatus)) return false;
  const days = bookedDayKeys(b);
  if (days.length === 0) return false;
  if (days[0] < window.fromKey) return false;
  if (days[days.length - 1] >= window.todayKey) return false;
  return !days.some((d) => attended.has(`${b.staff_id}|${b.job_id}|${d}`));
}

/** One "not attended" booking for the list above the board. */
export interface NotAttendedItem {
  bookingId: string;
  jobId: string;
  staffId: string;
  /** Its booked days (Melbourne keys), first to last. */
  dayKeys: string[];
}

/** Every not-attended booking, most recent last day first. */
export function notAttendedBookings(
  bookings: readonly AttendanceBooking[],
  jobStatus: (jobId: string) => string | null | undefined,
  entries: readonly AttendanceEntry[],
  window: AttendanceWindow,
): NotAttendedItem[] {
  const attended = attendedKeys(entries);
  const out: NotAttendedItem[] = [];
  for (const b of bookings) {
    if (!isNotAttended(b, jobStatus(b.job_id), attended, window)) continue;
    out.push({ bookingId: b.id, jobId: b.job_id, staffId: b.staff_id as string, dayKeys: bookedDayKeys(b) });
  }
  return out.sort((a, b) => (a.dayKeys[a.dayKeys.length - 1] < b.dayKeys[b.dayKeys.length - 1] ? 1 : -1));
}

/** The jobs whose time entries the rule needs: those with a past, unflagged, assigned booking in the window. */
export function attendanceCandidateJobIds(
  bookings: readonly AttendanceBooking[],
  jobStatus: (jobId: string) => string | null | undefined,
  window: AttendanceWindow,
): string[] {
  const ids = new Set<string>();
  const none = new Set<string>();
  for (const b of bookings) if (isNotAttended(b, jobStatus(b.job_id), none, window)) ids.add(b.job_id);
  return [...ids];
}

/** "3 bookings not attended". */
export function notAttendedHeadline(n: number): string {
  return `${n} booking${n === 1 ? "" : "s"} not attended`;
}

/**
 * A booking's flag as the screen should show it, with a queued (not yet
 * synced) change from this phone laid over the server's: `undefined` = no
 * queued change; `null` = a queued clear; otherwise a queued flag.
 */
export function withQueuedMissed<B extends MissedFields>(b: B, queued: { reason: string; note: string | null } | null | undefined): B {
  if (queued === undefined) return b;
  if (queued === null) return { ...b, missed_at: null, missed_reason: null, missed_note: null };
  return { ...b, missed_at: b.missed_at ?? new Date().toISOString(), missed_reason: queued.reason, missed_note: queued.note };
}

/**
 * Whether PostgREST says 0121's columns aren't there yet: 42703 on a select,
 * PGRST204 on a body — code AND column name, never the message alone.
 */
export function isMissingMissedColumn(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return !!error && (error.code === "42703" || error.code === "PGRST204") && /\bmissed_/.test(error.message ?? "");
}
