// Job bookings — each technician's own time and cost centre on a job.
//
// job_bookings (migration 0079, a DRAFT that is NOT APPLIED to production yet)
// is the source of truth for scheduling once it is applied: jobs.scheduled_*
// and the crew (job_assignments) are derived from it by triggers. This file is
// the web's one door to it: the pure rules (what a booking's window means, how
// a dialog row becomes rows to write) and the reads/writes the Schedule dialog,
// the job page and the schedule board share.
//
// A booking's window means exactly what a job's window meant under 0071, so it
// is NOT re-implemented here: bookingWindow() hands a booking to
// lib/scheduling.ts (scheduleDays, moveSchedule, buildScheduleColumns …) in the
// job-shaped form those functions already take. One rule, two shapes.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import {
  buildScheduleColumns,
  scheduleDays,
  scheduleInputFromJob,
  type ScheduleInput,
  type ScheduledJobWindow,
} from "./scheduling";
import { describeSchedule, formatDateKeyRange, formatScheduleDates, formatScheduleHours } from "./schedule-form";

export interface JobBooking {
  id: string;
  job_id: string;
  /** null = unassigned (the board's Unassigned row). */
  staff_id: string | null;
  cost_center_id: string | null;
  starts_at: string;
  ends_at: string | null;
  daily: boolean;
  all_day: boolean;
  google_event_id?: string | null;
  updated_at?: string | null;
}

export interface JobBookingWithNames extends JobBooking {
  staff_name: string | null;
  cost_center_name: string | null;
}

/** The columns every reader selects. */
export const BOOKING_COLUMNS = "id, job_id, staff_id, cost_center_id, starts_at, ends_at, daily, all_day";

/** The window columns a booking write sets — buildBookingWindow() returns exactly these. */
export interface BookingWindowColumns {
  starts_at: string;
  ends_at: string | null;
  daily: boolean;
  all_day: boolean;
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/** A booking as the job-shaped window lib/scheduling.ts reads. */
export function bookingWindow(
  b: Pick<JobBooking, "starts_at" | "ends_at" | "daily" | "all_day">,
): ScheduledJobWindow & { schedule_all_day: boolean } {
  return { scheduled_start: b.starts_at, scheduled_end: b.ends_at, schedule_daily: b.daily, schedule_all_day: b.all_day };
}

/** A schedule form's input as booking columns. Call validateScheduleInput first. */
export function buildBookingWindow(input: ScheduleInput): BookingWindowColumns {
  const c = buildScheduleColumns(input);
  return { starts_at: c.scheduled_start, ends_at: c.scheduled_end, daily: c.schedule_daily, all_day: c.schedule_all_day };
}

/** A saved booking as schedule form input (the reverse of buildBookingWindow). */
export function bookingScheduleInput(b: Pick<JobBooking, "starts_at" | "ends_at" | "daily" | "all_day">): ScheduleInput {
  // scheduleInputFromJob only returns null for a missing start, and a booking
  // always has one (starts_at is NOT NULL).
  return scheduleInputFromJob(bookingWindow(b))!;
}

/** "Booked Mon 19 – Wed 21 Oct, 7:00–15:30 each weekday (3 days, 25.5 h)". */
export function describeBooking(b: Pick<JobBooking, "starts_at" | "ends_at" | "daily" | "all_day">): string {
  return describeSchedule(bookingWindow(b)) ?? "";
}

function instant(iso: string | null): number | null {
  return iso === null ? null : new Date(iso).getTime();
}

/** Whether two windows are the same booking time (instants, not strings — PostgREST reformats). */
export function sameBookingWindow(
  a: Pick<JobBooking, "starts_at" | "ends_at" | "daily" | "all_day">,
  b: Pick<JobBooking, "starts_at" | "ends_at" | "daily" | "all_day">,
): boolean {
  return instant(a.starts_at) === instant(b.starts_at) && instant(a.ends_at) === instant(b.ends_at) && a.daily === b.daily && a.all_day === b.all_day;
}

/** Earliest first, then by technician so a pair on the same window sits together. */
export function compareBookings(a: JobBooking, b: JobBooking): number {
  const diff = new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
  if (diff !== 0) return diff;
  return (a.staff_id ?? "~").localeCompare(b.staff_id ?? "~");
}

/**
 * What PostgREST answers when job_bookings does not exist yet — the table
 * comes from 0079, a draft that is not applied. Readers fall back on the
 * job-level window (bookingsFromJobWindow) instead of showing an empty
 * schedule, the same way the board fell back while 0071 was unapplied.
 * 42P01 undefined table; PGRST205 table not in the schema cache; PGRST200 an
 * embed whose relationship is unknown.
 */
export function isBookingsTableMissing(error: { code?: string | null } | null | undefined): boolean {
  return !!error && (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST200");
}

/**
 * The bookings a job would have under 0079's own conversion (still a draft,
 * not applied): one per crew member on the job's window, or one unassigned
 * booking when there is no crew. Used only as the read fallback above; the
 * ids are synthetic ("legacy:…") and never written.
 */
export function bookingsFromJobWindow(
  job: {
    id: string;
    scheduled_start: string | null;
    scheduled_end: string | null;
    schedule_daily?: boolean | null;
    schedule_all_day?: boolean | null;
    scheduled_cost_center_id?: string | null;
  },
  crew: readonly string[],
): JobBooking[] {
  if (!job.scheduled_start) return [];
  const staff: (string | null)[] = crew.length > 0 ? [...crew] : [null];
  return staff.map((staffId) => ({
    id: `legacy:${job.id}:${staffId ?? "unassigned"}`,
    job_id: job.id,
    staff_id: staffId,
    cost_center_id: job.scheduled_cost_center_id ?? null,
    starts_at: job.scheduled_start!,
    ends_at: job.scheduled_end,
    daily: !!job.schedule_daily,
    all_day: !!job.schedule_all_day,
  }));
}

export function isSyntheticBooking(b: Pick<JobBooking, "id">): boolean {
  return b.id.startsWith("legacy:");
}

/**
 * One line for the job header: who, and over which days.
 *   "Dave · Mon 19 Oct, 7:00–15:30"            one booking
 *   "Dave, Sam · Mon 19 – Thu 22 Oct (3 bookings)"
 * Null when there are none ("Not scheduled").
 */
export function summariseBookings(bookings: readonly JobBookingWithNames[]): string | null {
  if (bookings.length === 0) return null;
  const names: string[] = [];
  for (const b of bookings) {
    const name = b.staff_name ?? (b.staff_id ? "Technician" : "Unassigned");
    if (!names.includes(name)) names.push(name);
  }
  const days = bookings.flatMap((b) => scheduleDays(bookingWindow(b))).map((d) => d.dateKey).sort();
  if (bookings.length === 1) {
    const b = bookings[0];
    const hours = formatScheduleHours(bookingWindow(b));
    return `${names[0]} · ${formatScheduleDates(bookingWindow(b))}${hours ? `, ${hours}${b.daily && days.length > 1 ? " daily" : ""}` : ""}`;
  }
  return `${names.join(", ")} · ${formatDateKeyRange(days[0], days[days.length - 1])} (${bookings.length} bookings)`;
}

// ---------------------------------------------------------------------------
// The Schedule dialog's rows → writes
// ---------------------------------------------------------------------------

/**
 * One row of the Schedule dialog. A row is "these technicians, this cost
 * centre, this time": picking several technicians makes one booking EACH with
 * the same window (Justin, 19 Oct 2026). A row that came from a saved booking
 * keeps that booking's id, so editing it updates the row in place rather than
 * deleting and re-inserting — which would drop the calendar event link and
 * re-fire the "New job assigned" push for a technician already on the job.
 */
export interface BookingDraft {
  /** The saved booking this row edits; undefined for a new row. */
  bookingId?: string;
  /** Empty = one unassigned booking. */
  staffIds: string[];
  costCenterId: string | null;
  schedule: ScheduleInput;
}

export type BookingInsert = BookingWindowColumns & { job_id: string; staff_id: string | null; cost_center_id: string | null };
export type BookingUpdate = { id: string; patch: Partial<BookingWindowColumns> & { staff_id?: string | null; cost_center_id?: string | null } };

export interface BookingSavePlan {
  inserts: BookingInsert[];
  updates: BookingUpdate[];
  deletes: string[];
}

/**
 * What saving the dialog writes, given the bookings it opened with and the
 * rows it closes with. Rows must already be valid (validateScheduleInput).
 *
 * - A row's saved booking keeps its technician when still picked (otherwise
 *   it goes to the first one picked, or becomes unassigned), updated only
 *   where something changed; each further technician is a new booking.
 * - A saved booking whose row was removed is deleted.
 *
 * Order of the WRITES is the caller's (saveBookingPlan): inserts and updates
 * first, deletes last, so a technician moved from one row to another never
 * passes through "no bookings" — the 0079 trigger (draft, not applied) would
 * take them off the crew and the insert would put them back with a fresh
 * "New job assigned" push.
 */
export function planBookingSave(jobId: string, saved: readonly JobBooking[], rows: readonly BookingDraft[]): BookingSavePlan {
  const savedById = new Map(saved.map((b) => [b.id, b]));
  const kept = new Set<string>();
  const plan: BookingSavePlan = { inserts: [], updates: [], deletes: [] };

  for (const row of rows) {
    const window = buildBookingWindow({ ...row.schedule, endDateKey: row.schedule.endDateKey || row.schedule.startDateKey });
    const original = row.bookingId ? savedById.get(row.bookingId) : undefined;
    let staff: (string | null)[] = row.staffIds.length > 0 ? [...new Set(row.staffIds)] : [null];
    // The saved booking stays with its own technician when they are still
    // picked, so adding Sam to Dave's row inserts Sam rather than handing
    // Dave's booking (and its calendar event) to Sam and re-inserting Dave.
    if (original && staff.includes(original.staff_id)) {
      staff = [original.staff_id, ...staff.filter((s) => s !== original.staff_id)];
    }
    let rest = staff;
    if (original) {
      kept.add(original.id);
      const [first, ...others] = staff;
      rest = others;
      const patch: BookingUpdate["patch"] = {};
      if (first !== original.staff_id) patch.staff_id = first;
      if (row.costCenterId !== original.cost_center_id) patch.cost_center_id = row.costCenterId;
      if (!sameBookingWindow(window, original)) Object.assign(patch, window);
      if (Object.keys(patch).length > 0) plan.updates.push({ id: original.id, patch });
    }
    for (const staffId of rest) {
      plan.inserts.push({ job_id: jobId, staff_id: staffId, cost_center_id: row.costCenterId, ...window });
    }
  }

  for (const b of saved) if (!kept.has(b.id)) plan.deletes.push(b.id);
  return plan;
}

// ---------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------

type Client = SupabaseClient<Database>;

/**
 * A job's bookings with the technician's and the cost centre's names.
 *
 * Cost centre names come from po_cost_centers_public, the money-free view
 * (0038): a technician cannot read po_cost_centers itself, and a booking's
 * cost centre is shown to everyone. Staff names come from the staff list the
 * caller already holds, because every page that shows bookings has one.
 *
 * `missingTable` is true when job_bookings does not exist (0079 is still a
 * draft, not applied) — the caller decides what to fall back on.
 */
export async function loadJobBookings(
  supabase: Client,
  jobId: string,
  staff: readonly { id: string; full_name: string }[],
): Promise<{ bookings: JobBookingWithNames[]; error: string | null; missingTable: boolean }> {
  const { data, error } = await supabase
    .from("job_bookings")
    .select(`${BOOKING_COLUMNS}, google_event_id, updated_at`)
    .eq("job_id", jobId)
    .order("starts_at", { ascending: true });
  if (error) return { bookings: [], error: error.message, missingTable: isBookingsTableMissing(error) };
  const rows = (data ?? []) as JobBooking[];
  return { bookings: await withNames(supabase, rows, staff), error: null, missingTable: false };
}

/** Adds staff_name / cost_center_name to bookings (synthetic ones included), sorted. */
export function nameBookings(
  rows: readonly JobBooking[],
  staff: readonly { id: string; full_name: string }[],
  costCenterNames: ReadonlyMap<string, string>,
): JobBookingWithNames[] {
  const staffNames = new Map(staff.map((s) => [s.id, s.full_name]));
  return [...rows].sort(compareBookings).map((b) => ({
    ...b,
    staff_name: b.staff_id ? staffNames.get(b.staff_id) ?? null : null,
    cost_center_name: b.cost_center_id ? costCenterNames.get(b.cost_center_id) ?? null : null,
  }));
}

/** nameBookings, reading the cost centre names it needs. */
export async function withNames(
  supabase: Client,
  rows: readonly JobBooking[],
  staff: readonly { id: string; full_name: string }[],
): Promise<JobBookingWithNames[]> {
  const ccIds = [...new Set(rows.map((b) => b.cost_center_id).filter((id): id is string => !!id))];
  const ccNames = new Map<string, string>();
  if (ccIds.length > 0) {
    const { data: ccs } = await supabase.from("po_cost_centers_public").select("id, name").in("id", ccIds);
    for (const cc of ccs ?? []) if (cc.id && cc.name) ccNames.set(cc.id, cc.name);
  }
  return nameBookings(rows, staff, ccNames);
}

export type BookingWriteResult = { ok: true } | { ok: false; error: string };

/**
 * The narrow slice of the client the board's writes use. Narrowed for the
 * same reason as ScheduleWriteClient in lib/schedule-dispatch.ts: the fully
 * generic typed client trips TS2589 when matched structurally.
 */
export type BookingWriteClient = {
  from(table: "job_bookings"): {
    insert(row: BookingInsert | BookingInsert[]): {
      select(columns: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
    };
    update(patch: BookingUpdate["patch"], options?: { count: "exact" }): {
      eq(column: "id", value: string): PromiseLike<{ error: { message: string } | null; count?: number | null }>;
    };
    delete(options?: { count: "exact" }): {
      eq(column: "id", value: string): PromiseLike<{ error: { message: string } | null; count?: number | null }>;
    };
  };
};

// `count: "exact"` on every update/delete: RLS (office/admin only) filters a
// refused row out and PostgREST reports success against zero rows. Taken as
// success, the board would keep an optimistic move the database never made.
const REFUSED = "That booking could not be changed — it may have been removed, or you may not have permission.";

export async function updateBooking(supabase: BookingWriteClient, id: string, patch: BookingUpdate["patch"]): Promise<BookingWriteResult> {
  const { error, count } = await supabase.from("job_bookings").update(patch, { count: "exact" }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  if (count === 0) return { ok: false, error: REFUSED };
  return { ok: true };
}

export async function deleteBooking(supabase: BookingWriteClient, id: string): Promise<BookingWriteResult> {
  const { error, count } = await supabase.from("job_bookings").delete({ count: "exact" }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  if (count === 0) return { ok: false, error: REFUSED };
  return { ok: true };
}

/** Inserts and returns the new rows (with their ids), so the board can swap its optimistic copy for the real one. */
export async function insertBookings(
  supabase: BookingWriteClient,
  rows: BookingInsert[],
): Promise<{ ok: true; rows: JobBooking[] } | { ok: false; error: string }> {
  if (rows.length === 0) return { ok: true, rows: [] };
  const { data, error } = await supabase.from("job_bookings").insert(rows).select(BOOKING_COLUMNS);
  if (error) return { ok: false, error: error.message };
  // An insert RLS refuses is an error, not a silent zero — but check anyway.
  if ((data ?? []).length !== rows.length) return { ok: false, error: REFUSED };
  return { ok: true, rows: data as JobBooking[] };
}

/**
 * Write a dialog save: inserts and updates first, deletes last (see
 * planBookingSave). Not atomic — PostgREST has no multi-statement transaction
 * and an RPC would need a migration — so it stops at the first refusal and
 * says whether anything had already landed (`partial`); the caller then
 * refreshes the page so what is shown is what was saved.
 */
export async function saveBookingPlan(
  supabase: BookingWriteClient,
  plan: BookingSavePlan,
): Promise<{ ok: true } | { ok: false; error: string; partial: boolean }> {
  const inserted = await insertBookings(supabase, plan.inserts);
  if (!inserted.ok) return { ok: false, error: `New bookings were not saved: ${inserted.error}`, partial: false };
  let partial = plan.inserts.length > 0;
  for (const u of plan.updates) {
    const r = await updateBooking(supabase, u.id, u.patch);
    if (!r.ok) return { ok: false, error: `A booking was not updated: ${r.error}`, partial };
    partial = true;
  }
  for (const id of plan.deletes) {
    const r = await deleteBooking(supabase, id);
    if (!r.ok) return { ok: false, error: `A booking was not removed: ${r.error}`, partial };
    partial = true;
  }
  return { ok: true };
}

/** Whether a plan writes anything at all. */
export function isEmptyPlan(plan: BookingSavePlan): boolean {
  return plan.inserts.length === 0 && plan.updates.length === 0 && plan.deletes.length === 0;
}
