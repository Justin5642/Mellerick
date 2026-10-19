import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOperation, SideEffectOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";
import type { ScheduleColumns } from "../../scheduling";
import { bookingColumns, type BookingWindowColumns } from "../../bookings";

/**
 * How a moved schedule's two flags change (migration 0071). Omitted fields are
 * left as stored — a reschedule never touches what it does not know about.
 */
/** What an edit to one booking may change. Omitted fields are left as stored. */
export interface BookingPatch {
  staffId?: string | null;
  costCenterId?: string | null;
  /** The window and both 0071 flags, always together (buildScheduleColumns, or a moved window). */
  columns?: BookingWindowColumns;
}

export interface RescheduleFlags {
  scheduleDaily?: boolean;
  scheduleAllDay?: boolean;
}

// Offline-first schedule dispatch (office/admin), mirroring the web schedule
// board's drag-to-reassign and drag-to-reschedule (components/schedule/
// team-schedule-view.tsx). Each change is a durable `job` update routed through
// the outbox, followed by a coalesced best-effort calendar resync. Reassign and
// reschedule are separate (preserve-on-update) — exactly the web's two update
// paths — so a reassign never clobbers the times and vice-versa.
export class ScheduleRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  /** Assign (or unassign, with null) a job to a technician. */
  async reassign(jobId: string, assignedTo: string | null): Promise<void> {
    await this.updateJob(jobId, { assigned_to: assignedTo });
  }

  /**
   * Move a job to new start/end instants. Compute them with moveSchedule() for
   * a daily job (keeps its hours and NUMBER OF BOOKED DAYS) or
   * computeRescheduleWithTime() for a continuous block. `flags` writes
   * schedule_daily / schedule_all_day alongside, so a block moved off the
   * standard shift stops claiming to be "All day".
   */
  async reschedule(
    jobId: string,
    scheduledStartIso: string,
    scheduledEndIso: string | null,
    flags: RescheduleFlags = {}
  ): Promise<void> {
    const payload: Record<string, unknown> = { scheduled_start: scheduledStartIso, scheduled_end: scheduledEndIso };
    if (flags.scheduleDaily !== undefined) payload.schedule_daily = flags.scheduleDaily;
    if (flags.scheduleAllDay !== undefined) payload.schedule_all_day = flags.scheduleAllDay;
    await this.updateJob(jobId, payload);
  }

  /**
   * Take a job off the schedule. Both 0071 flags reset with the window, so a
   * job scheduled again later never inherits "daily" or "All day" from a
   * schedule that no longer exists.
   */
  async clearSchedule(jobId: string): Promise<void> {
    await this.updateJob(jobId, {
      scheduled_start: null,
      scheduled_end: null,
      schedule_daily: false,
      schedule_all_day: false,
    });
  }

  /**
   * The "Schedule Job" flow's confirm step: assign + set the time block in
   * one write (one outbox entry, one coalesced calendar sync) rather than a
   * reassign() + reschedule() pair — mirrors the web dialog's single
   * applyScheduleChange call, so a job is never briefly assigned with no
   * time (or timed with no assignee) between two separate writes.
   *
   * `assigned_to` is deliberately NOT written here (migration 0059). It is
   * derived by the `sync_job_primary_assignee` trigger from `job_assignments`,
   * which is set below via the `set_job_assignments` RPC (proxied through the
   * assign-technicians side effect, since the outbox cannot call RPCs
   * directly). Writing `assigned_to` directly here too would race: the
   * `collapse_job_assignments_on_direct_write` trigger would first collapse
   * job_assignments down to one row, with the full crew only restored once
   * the dependent side effect lands.
   */
  async schedule(
    jobId: string,
    staffIds: string[],
    columns: ScheduleColumns,
    costCenterId: string | null = null
  ): Promise<void> {
    // `columns` comes from buildScheduleColumns() (lib/scheduling.ts), so the
    // window and both 0071 flags are always written together — a single-day
    // reschedule of a once-daily job resets schedule_daily, not just the times.
    const opId = await this.updateJob(jobId, {
      scheduled_start: columns.scheduled_start,
      scheduled_end: columns.scheduled_end,
      schedule_daily: columns.schedule_daily,
      schedule_all_day: columns.schedule_all_day,
      scheduled_cost_center_id: costCenterId,
    });
    const assign: SideEffectOperation = {
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "assign-technicians",
      coalesceKey: `assign-technicians:${jobId}`,
      payload: { jobId, staffIds },
      dependsOn: opId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(assign);
  }

  /**
   * Set a job's whole crew (any number of technicians, or none) without
   * touching its times. Goes through the same assign-technicians side effect
   * as schedule() → set_job_assignments, which only ADDS people new to the
   * crew (so they alone get the "New job assigned" push, 0077) and removes the
   * rest. reassign() above writes assigned_to, which collapses the crew to one
   * person; this is what the Schedule tab's crew picker uses instead.
   */
  async setCrew(jobId: string, staffIds: string[]): Promise<void> {
    const assign: SideEffectOperation = {
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "assign-technicians",
      coalesceKey: `assign-technicians:${jobId}`,
      payload: { jobId, staffIds: [...new Set(staffIds)] },
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(assign);
  }

  // -------------------------------------------------------------------------
  // Bookings (migration 0079 — a DRAFT, not applied yet). The schedule editor
  // writes job_bookings rows; the database derives the job-level schedule and
  // the crew from them (a newly booked technician joins the crew, which sends
  // the "New job assigned" push; one whose last booking goes leaves it). So
  // these never touch jobs.* or set_job_assignments.
  //
  // job_bookings is a plain table with a uuid PK, so the outbox's ordinary
  // replay applies: the insert carries a client-generated id (a replay
  // collides on job_bookings_pkey and counts as success), an edit or delete
  // of a booking still queued waits for its insert (Outbox.enqueue), and an
  // edit that matches no row fails loudly instead of vanishing.
  // -------------------------------------------------------------------------

  /**
   * One booking per technician on the same window and cost centre — the
   * editor's "add" row. No technicians = one unassigned booking.
   * Returns the new booking ids, in `staffIds` order.
   */
  async addBookings(
    jobId: string,
    staffIds: string[],
    columns: ScheduleColumns,
    costCenterId: string | null
  ): Promise<string[]> {
    const people: (string | null)[] = staffIds.length > 0 ? [...new Set(staffIds)] : [null];
    const ids: string[] = [];
    let lastOp: string | null = null;
    for (const staffId of people) {
      const rowId = this.ids.newId();
      lastOp = await this.writeBooking("insert", rowId, {
        job_id: jobId,
        staff_id: staffId,
        cost_center_id: costCenterId,
        ...bookingColumns(columns),
      });
      ids.push(rowId);
    }
    await this.syncCalendar(jobId, lastOp);
    return ids;
  }

  async updateBooking(jobId: string, bookingId: string, patch: BookingPatch): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (patch.staffId !== undefined) payload.staff_id = patch.staffId;
    if (patch.costCenterId !== undefined) payload.cost_center_id = patch.costCenterId;
    if (patch.columns) Object.assign(payload, bookingColumns(patch.columns));
    if (Object.keys(payload).length === 0) return;
    const opId = await this.writeBooking("update", bookingId, payload);
    await this.syncCalendar(jobId, opId);
  }

  async deleteBooking(jobId: string, bookingId: string): Promise<void> {
    const opId = await this.writeBooking("delete", bookingId, {});
    await this.syncCalendar(jobId, opId);
  }

  private async writeBooking(op: "insert" | "update" | "delete", rowId: string, payload: Record<string, unknown>): Promise<string> {
    const opId = this.ids.newId();
    const write: WriteOperation = {
      kind: "write",
      id: opId,
      rowId,
      aggregate: "job_booking",
      op,
      table: "job_bookings",
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);
    return opId;
  }

  /** Resync the job's calendar once `afterOp` has landed (coalesced per job). */
  private async syncCalendar(jobId: string, afterOp: string | null): Promise<void> {
    const cal: SideEffectOperation = {
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "sync-calendar",
      coalesceKey: `sync-calendar:${jobId}`,
      payload: { jobId },
      dependsOn: afterOp,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(cal);
  }

  private async updateJob(jobId: string, payload: Record<string, unknown>): Promise<string> {
    const opId = this.ids.newId();
    const op: WriteOperation = {
      kind: "write",
      id: opId,
      rowId: jobId,
      aggregate: "job",
      op: "update",
      table: "jobs",
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(op);
    // Resync the calendar once the job change has landed (coalesced per job).
    const cal: SideEffectOperation = {
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "sync-calendar",
      coalesceKey: `sync-calendar:${jobId}`,
      payload: { jobId },
      dependsOn: opId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(cal);
    return opId;
  }
}
