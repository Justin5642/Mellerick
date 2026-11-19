import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOperation, SideEffectOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

export interface JobFieldsInput {
  status?: string;
  priority?: string;
  title?: string;
  jobType?: string;
  description?: string | null;
  notes?: string | null;
}

export interface CreateJobInput {
  customerId: string;
  title: string;
  siteId?: string | null;
  assignedTo?: string | null;
  /**
   * The crew, first = primary. Overrides assignedTo when given: the first is
   * written as assigned_to, and two or more also queue set_job_assignments
   * for the whole list (see createJob).
   */
  crewIds?: string[];
  jobType?: string;
  priority?: string;
  status?: string;
  scheduledStartIso?: string | null;
  scheduledEndIso?: string | null;
  description?: string | null;
  /**
   * The COMPANY cost centre (cost_centres) the new job's bookings are for —
   * every booking asks for one (19 Nov 2026). The job has no PO lines yet, so
   * a booking-cost-centre side effect finds or adds the line on the server
   * and tags the bookings the insert made.
   */
  bookingCostCentreId?: string | null;
}

export interface ConvertQuoteInput {
  quoteId: string;
  title: string;
  notes?: string | null; // → the new job's description (matches web)
  customerId: string;
  siteId?: string | null;
  items: { name: string; description: string | null; quantity: number; unitPrice: number }[];
  createdBy?: string | null;
}

// Offline-first edits to a job's own fields (status / priority / type /
// description / internal notes). Preserve-on-update: ONLY the fields explicitly
// provided are written, so a status change never wipes the description and
// vice-versa. Assignee + schedule live in ScheduleRepository (the schedule
// board's concern); billing/approval flags have their own repositories.
export class JobsRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  // Create a new job (office/admin). job_number is a DB serial, so it's never
  // sent; the row PK is a client UUID for idempotent offline replay. When a
  // schedule is given, a coalesced calendar sync follows the insert. Only
  // customer_id + title are required (DB NOT NULL); the rest carry DB defaults.
  async createJob(input: CreateJobInput): Promise<string> {
    const rowId = this.ids.newId();
    const payload: Record<string, unknown> = { customer_id: input.customerId, title: input.title };
    if (input.siteId !== undefined) payload.site_id = input.siteId;
    const crew = input.crewIds ? [...new Set(input.crewIds)] : null;
    if (crew) payload.assigned_to = crew[0] ?? null;
    else if (input.assignedTo !== undefined) payload.assigned_to = input.assignedTo;
    if (input.jobType !== undefined) payload.job_type = input.jobType;
    if (input.priority !== undefined) payload.priority = input.priority;
    if (input.status !== undefined) payload.status = input.status;
    if (input.scheduledStartIso !== undefined) payload.scheduled_start = input.scheduledStartIso;
    if (input.scheduledEndIso !== undefined) payload.scheduled_end = input.scheduledEndIso;
    if (input.description !== undefined) payload.description = input.description;

    // A site (or customer) added moments ago on this phone may still be
    // queued: the job waits for it, so it can't arrive first and fail the
    // foreign key. The site's own insert already waits for its customer's.
    const after =
      (input.siteId ? await this.outbox.pendingInsertOpId("sites", input.siteId) : null) ??
      (await this.outbox.pendingInsertOpId("customers", input.customerId));

    const insertId = this.ids.newId();
    const op: WriteOperation = {
      kind: "write",
      id: insertId,
      rowId,
      aggregate: "job",
      op: "insert",
      table: "jobs",
      payload,
      ...(after ? { dependsOn: after } : {}),
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(op);

    // A crew of two or more, the same way as the website's New Job: the insert
    // makes the first technician the crew (0059) and, with a schedule, books
    // them on it (0079); set_job_assignments then adds the rest, and 0079
    // gives each newcomer their own booking on that one window. So N
    // technicians = N bookings, not one. Waits for the insert; the calendar
    // sync waits for this, so every booking gets its event.
    let lastId = insertId;
    if (crew && crew.length > 1) {
      const assign: SideEffectOperation = {
        kind: "side_effect",
        id: this.ids.newId(),
        effect: "assign-technicians",
        coalesceKey: `assign-technicians:${rowId}`,
        payload: { jobId: rowId, staffIds: crew },
        dependsOn: insertId,
        status: "pending",
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: this.time.nowMs(),
      };
      await this.outbox.enqueue(assign);
      lastId = assign.id;
    }

    if (input.scheduledStartIso && input.bookingCostCentreId) {
      const cc: SideEffectOperation = {
        kind: "side_effect",
        id: this.ids.newId(),
        effect: "booking-cost-centre",
        coalesceKey: `booking-cost-centre:${rowId}`,
        // poId: a client UUID, so a retry finds the PO it already made.
        payload: { jobId: rowId, costCentreId: input.bookingCostCentreId, poId: this.ids.newId(), applyToBookings: true },
        dependsOn: lastId,
        status: "pending",
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: this.time.nowMs(),
      };
      await this.outbox.enqueue(cc);
      lastId = cc.id;
    }

    if (input.scheduledStartIso) {
      const cal: SideEffectOperation = {
        kind: "side_effect",
        id: this.ids.newId(),
        effect: "sync-calendar",
        coalesceKey: `sync-calendar:${rowId}`,
        payload: { jobId: rowId },
        dependsOn: lastId,
        status: "pending",
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: this.time.nowMs(),
      };
      await this.outbox.enqueue(cal);
    }
    return rowId;
  }

  // Convert an accepted quote into a job (office/admin), mirroring the web
  // quote-detail convertToJob: create a pending service job from the quote,
  // copy the quote's line items to job_items, and link the quote back
  // (quotes.job_id), then add the quote-value PO (quote-po side effect).
  // Compound + durable: the items and the quote link are gated on the job
  // insert (dependsOn) so they never land before the job exists.
  async createJobFromQuote(input: ConvertQuoteInput): Promise<string> {
    const jobId = this.ids.newId();
    const jobOpId = await this.enqueueWrite("job", "insert", "jobs", jobId, {
      title: input.title,
      description: input.notes ?? null,
      customer_id: input.customerId,
      site_id: input.siteId ?? null,
      job_type: "service",
      status: "pending",
      created_by: input.createdBy ?? null,
    });
    for (const it of input.items) {
      await this.enqueueWrite("job_item", "insert", "job_items", this.ids.newId(), {
        job_id: jobId,
        name: it.name,
        description: it.description ?? null,
        quantity: it.quantity,
        unit_price: it.unitPrice,
        // total is a DB GENERATED column — never sent.
      }, jobOpId);
    }
    const linkOpId = await this.enqueueWrite("quote", "update", "quotes", input.quoteId, { job_id: jobId }, jobOpId);

    // The quote's subtotal becomes the job's budget PO, `<job number>-1`, as
    // on the web (lib/quote-job-po.ts). The job number is a database serial
    // the phone doesn't know until the insert has synced, so this is a server
    // side effect (/api/jobs/[id]/quote-po), not a purchase_orders write: it
    // waits for the quote link, then numbers the PO against the real job and
    // values it from the quote on the server. poId is a client UUID so a
    // retry finds the PO it already made.
    const po: SideEffectOperation = {
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "quote-po",
      coalesceKey: `quote-po:${jobId}`,
      payload: { jobId, quoteId: input.quoteId, poId: this.ids.newId() },
      dependsOn: linkOpId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(po);
    return jobId;
  }

  private async enqueueWrite(aggregate: WriteOperation["aggregate"], op: WriteOperation["op"], table: string, rowId: string, payload: Record<string, unknown>, dependsOn?: string): Promise<string> {
    const id = this.ids.newId();
    const write: WriteOperation = {
      kind: "write",
      id,
      rowId,
      aggregate,
      op,
      table,
      payload,
      dependsOn: dependsOn ?? null,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);
    return id;
  }

  /** Update only the provided fields. No-op if nothing was provided. */
  async updateFields(jobId: string, fields: JobFieldsInput): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (fields.status !== undefined) payload.status = fields.status;
    if (fields.priority !== undefined) payload.priority = fields.priority;
    if (fields.title !== undefined) payload.title = fields.title;
    if (fields.jobType !== undefined) payload.job_type = fields.jobType;
    if (fields.description !== undefined) payload.description = fields.description;
    if (fields.notes !== undefined) payload.notes = fields.notes;
    if (Object.keys(payload).length === 0) return;

    const op: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
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
  }
}
