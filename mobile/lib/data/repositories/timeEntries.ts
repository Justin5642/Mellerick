import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOp, WriteOperation, SideEffectOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";
import { notifyClockChanged, notifyClockedIn } from "../../clockEvents";
import { fixColumns, type ClockFix } from "../../clockFix";

// Re-exported for back-compat with existing importers of these from here.
export { systemTime, type TimeSource };

// Pure: worked hours between two ISO timestamps, rounded to 2dp; null if the
// end is not strictly after the start. Mirrors the web/mobile inline math
// (see mobile/components/job/time.tsx) so billing stays identical.
export function hoursBetween(startIso: string, endIso: string): number | null {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms <= 0) return null;
  return Math.round((ms / 3600000) * 100) / 100;
}

/** The database's time_entries_duration_sane rule (0051): a closed entry ends after it starts, within 24 hours. */
export const MAX_ENTRY_MS = 24 * 60 * 60 * 1000;

/**
 * Why the database would refuse closing an entry at these times, or null.
 *
 * Checked BEFORE a change is queued. Queuing one the server will always
 * refuse is how a clock-off sat in Justin's "not synced" list from 2 Nov to
 * 15 Nov 2026 ("violates check constraint time_entries_duration_sane"): an
 * entry left clocked on for over a day, then clocked off "now". The entry
 * itself stayed open on the server the whole time.
 */
export function closeProblem(clockInIso: string, clockOutIso: string): "before_start" | "over_24h" | null {
  const ms = Date.parse(clockOutIso) - Date.parse(clockInIso);
  if (!(ms > 0)) return "before_start";
  if (ms > MAX_ENTRY_MS) return "over_24h";
  return null;
}

/** Thrown instead of queuing a time entry change the server will refuse. */
export class TimeEntryRefused extends Error {
  constructor(
    readonly problem: "before_start" | "over_24h",
    clockInIso: string
  ) {
    super(
      problem === "over_24h"
        ? `This entry has been clocked on since ${new Date(clockInIso).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} — over 24 hours, which can't be saved. Edit the entry and set the real finish time (split it if it ran over two days).`
        : "The finish time is at or before the start time. Edit the entry and set the real times."
    );
    this.name = "TimeEntryRefused";
  }
}

/** `atIso` when given, valid and not after now; otherwise now. */
function notAfterNow(atIso: string | undefined, nowIso: string): string {
  if (!atIso) return nowIso;
  const at = Date.parse(atIso);
  if (!Number.isFinite(at) || at > Date.parse(nowIso)) return nowIso;
  return new Date(at).toISOString();
}

function assertClosable(clockInIso: string, clockOutIso: string | null | undefined): void {
  if (!clockOutIso) return;
  const problem = closeProblem(clockInIso, clockOutIso);
  if (problem) throw new TimeEntryRefused(problem, clockInIso);
}

export interface ManualEntryInput {
  jobId: string;
  staffId: string;
  entryType: "work" | "travel";
  clockInIso: string;
  clockOutIso: string | null;
  costCenterId: string | null;
  /** The job just left — set only for an auto-clocked travel leg. */
  travelFromJobId?: string | null;
  /** True when the geofence generated this entry rather than a person typing it. */
  autoClocked?: boolean;
  /**
   * Who typed it, when that is not the person the hours belong to — office or
   * admin logging time for a technician. Defaults to `staffId`.
   */
  editorId?: string;
  /** Admin only (the 0025 trigger drops it for anyone else). Omitted = not sent. */
  rateOverride?: RateOverride | null;
}

/**
 * The billing band an admin can force on a work entry (time_entries.rate_override,
 * 0025): null = auto-detect by day and time. A money column — technicians can
 * neither read it (0045) nor set it (0025's trigger reverts them).
 */
export type RateOverride = "normal" | "time_and_half" | "double_time";

export interface EditEntryInput {
  entryId: string;
  editorId: string;
  clockInIso: string;
  clockOutIso: string | null;
  costCenterId: string | null;
  /** Re-attribute the hours to another person (office/admin; RLS 0030). Omitted = unchanged. */
  staffId?: string;
  /** Admin only. Omitted = unchanged — the phone can't read the current value (0045), so it never sends one it didn't choose. */
  rateOverride?: RateOverride | null;
}

// Offline-first replacement for the direct-Supabase writes in JobTimeTab. Every
// mutation becomes a durable outbox operation (client-UUID PK => idempotent
// replay), and — exactly where the web app calls syncBilling — a coalesced
// sync-billing side-effect that depends on the write so it never fires before
// the row it bills for exists. Reads still come from repositories over the
// (RLS-protected) Supabase client; this class owns the write path only.
export class TimeEntriesRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  /** Clock in now. Returns the new entry's client-generated id. */
  /**
   * `autoClocked` marks an entry the GEOFENCE started rather than the
   * technician. It defaults false so the manual clock button is unchanged, but
   * the foreground auto-clock must pass true: the background task writes
   * `auto_clocked: true` directly, and until this option existed the two paths
   * recorded the same event differently — exactly the divergence
   * backgroundClockTask.ts:18-22 warns "would show up only as a disputed
   * payslip".
   */
  async clockIn(input: {
    jobId: string;
    staffId: string;
    autoClocked?: boolean;
    costCenterId?: string | null;
    fix?: ClockFix | null;
    /** Backdate the clock-on (the "stopped here" prompt: the stay's first fix). Never in the future. */
    atIso?: string;
    /**
     * The entry's id, when the caller already gave it to the server — "Start
     * work on this job" links the technician's new booking to it (0118 (draft)), so
     * the booking ends when this entry is clocked off. Otherwise a new id.
     */
    id?: string;
  }): Promise<string> {
    const rowId = input.id ?? this.ids.newId();
    const opId = await this.enqueueWrite(rowId, "insert", {
      job_id: input.jobId,
      staff_id: input.staffId,
      clock_in: notAfterNow(input.atIso, this.time.nowIso()),
      auto_clocked: input.autoClocked ?? false,
      cost_center_id: input.costCenterId ?? null,
      // Where the phone was (0092) — only when known.
      ...fixColumns("clock_in", input.fix),
    });
    await this.enqueueBillingSync(rowId, opId);
    notifyClockedIn({ entryId: rowId, jobId: input.jobId, fix: input.fix ?? null });
    return rowId;
  }

  /** Clock out an open entry now, computing hours from its clock-in. */
  async clockOut(input: {
    entryId: string;
    clockInIso: string;
    fix?: ClockFix | null;
    /** Backdate the clock-off (the "left the site" prompt: the first fix outside). Never in the future. */
    atIso?: string;
  }): Promise<void> {
    const clockOutIso = notAfterNow(input.atIso, this.time.nowIso());
    assertClosable(input.clockInIso, clockOutIso);
    const opId = await this.enqueueWrite(input.entryId, "update", {
      clock_out: clockOutIso,
      hours: hoursBetween(input.clockInIso, clockOutIso),
      ...fixColumns("clock_out", input.fix),
    });
    await this.enqueueBillingSync(input.entryId, opId);
  }

  /** Add a backdated manual entry (used when auto clock-in/out didn't fire). */
  async addManual(input: ManualEntryInput): Promise<string> {
    assertClosable(input.clockInIso, input.clockOutIso);
    const rowId = this.ids.newId();
    const opId = await this.enqueueWrite(rowId, "insert", {
      job_id: input.jobId,
      staff_id: input.staffId,
      entry_type: input.entryType,
      clock_in: input.clockInIso,
      clock_out: input.clockOutIso,
      hours: input.clockOutIso ? hoursBetween(input.clockInIso, input.clockOutIso) : null,
      cost_center_id: input.costCenterId,
      // The geofence auto-clock reuses this method for its travel legs, which
      // previously went straight to Supabase and were therefore lost outright
      // when logged with no signal. Spread rather than always-present so the
      // manual path's payload shape is unchanged.
      auto_clocked: input.autoClocked ?? false,
      ...(input.travelFromJobId ? { travel_from_job_id: input.travelFromJobId } : {}),
      ...(input.rateOverride !== undefined ? { rate_override: input.rateOverride } : {}),
      edited_by: input.editorId ?? input.staffId,
      edited_at: this.time.nowIso(),
    });
    await this.enqueueBillingSync(rowId, opId);
    return rowId;
  }

  /** Correct an existing entry's start/end/stage. */
  async editEntry(input: EditEntryInput): Promise<void> {
    assertClosable(input.clockInIso, input.clockOutIso);
    const opId = await this.enqueueWrite(input.entryId, "update", {
      clock_in: input.clockInIso,
      clock_out: input.clockOutIso,
      hours: input.clockOutIso ? hoursBetween(input.clockInIso, input.clockOutIso) : null,
      cost_center_id: input.costCenterId,
      ...(input.staffId ? { staff_id: input.staffId } : {}),
      ...(input.rateOverride !== undefined ? { rate_override: input.rateOverride } : {}),
      edited_by: input.editorId,
      edited_at: this.time.nowIso(),
    });
    await this.enqueueBillingSync(input.entryId, opId);
  }

  /** Assign an entry to a PO cost-center stage. Deliberately NO billing resync:
   * the generated Labour/Call-Out items are derived from hours only (see
   * lib/labour-billing-sync.ts — it never reads cost_center_id), so reassigning
   * a stage cannot change what's billed. Verified for Q6. */
  async assignCostCenter(entryId: string, costCenterId: string | null): Promise<void> {
    await this.enqueueWrite(entryId, "update", { cost_center_id: costCenterId });
  }

  /**
   * Delete an entry, then reconcile the job's billing (Q6).
   *
   * Deleting a billed entry used to leave its auto-generated "Labour" line item
   * behind — the job stayed billed for hours that no longer exist. We therefore
   * resync, but keyed on the JOB, not the entry: the entry-keyed endpoint
   * resolves the job FROM the entry, so once the row is gone it would 404. The
   * job-level route recomputes every remaining entry, so the stale line clears.
   * `jobId` is optional only for backwards compatibility; always pass it.
   */
  async remove(entryId: string, jobId?: string): Promise<void> {
    const opId = await this.enqueueWrite(entryId, "delete", {});
    if (jobId) await this.enqueueJobBillingSync(jobId, opId);
  }

  private async enqueueWrite(
    rowId: string,
    op: WriteOp,
    payload: Record<string, unknown>
  ): Promise<string> {
    const id = this.ids.newId();
    const write: WriteOperation = {
      kind: "write",
      id,
      rowId,
      aggregate: "time_entry",
      op,
      table: "time_entries",
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);
    // Every time-entry write can change whether the technician is on the clock,
    // which the location-tracking gate needs to know now (lib/clockEvents.ts).
    notifyClockChanged();
    return id;
  }

  // Job-level reconcile, gated on the write that triggered it. Coalesced per job
  // so several deletes in one offline session collapse to a single resync.
  private async enqueueJobBillingSync(jobId: string, dependsOn: string): Promise<void> {
    const op: SideEffectOperation = {
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "sync-job-billing",
      coalesceKey: `sync-job-billing:${jobId}`,
      payload: { jobId },
      dependsOn,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(op);
  }

  private async enqueueBillingSync(entryId: string, dependsOn: string): Promise<void> {
    const op: SideEffectOperation = {
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "sync-billing",
      coalesceKey: `sync-billing:${entryId}`,
      payload: { entryId },
      dependsOn,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(op);
  }
}
