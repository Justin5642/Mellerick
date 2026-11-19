import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  addableCostCentres,
  bookingCostCentreProblem,
  costCentreChoiceValue,
  defaultBookingCostCentre,
  lineLabel,
  parseCostCentreChoice,
  planBookingLine,
  PICK_COST_CENTRE,
} from "@/lib/booking-cost-centre";
import { planTodoDrop } from "@/lib/todo-board";

// Bookings always ask for a cost centre (Justin, 19 Nov 2026). Pinned: the
// default a new booking starts with, the "Pick a cost centre" check, which
// company cost centres are offered as "Add to this job", where a $0 line for
// one goes — and the route that adds it runs as the caller, office/admin only,
// and answers with names, never money.

const DRAIN = "cc-drain";
const TRANSPORT = "cc-transport";
const CIVIL = "cc-civil";
const company = [
  { id: DRAIN, name: "Below Ground Drainage" },
  { id: TRANSPORT, name: "Transport" },
  { id: CIVIL, name: "Civil" },
];

describe("defaultBookingCostCentre", () => {
  const lines = [{ id: "l1" }, { id: "l2" }];
  it("takes the booking above's", () => {
    expect(defaultBookingCostCentre({ previous: "l2", scheduled: "l1", lines })).toBe("l2");
  });
  it("else the job's scheduled cost centre", () => {
    expect(defaultBookingCostCentre({ previous: null, scheduled: "l1", lines })).toBe("l1");
  });
  it("else the job's only line", () => {
    expect(defaultBookingCostCentre({ lines: [{ id: "only" }] })).toBe("only");
  });
  it("never a line the job doesn't have, and nothing when there's a choice to make", () => {
    expect(defaultBookingCostCentre({ previous: "gone", scheduled: "gone-too", lines })).toBeNull();
    expect(defaultBookingCostCentre({ lines: [] })).toBeNull();
  });
});

describe("bookingCostCentreProblem", () => {
  it("asks for one when none is picked", () => {
    expect(bookingCostCentreProblem(null)).toBe(PICK_COST_CENTRE);
    expect(bookingCostCentreProblem(undefined)).toBe(PICK_COST_CENTRE);
    expect(bookingCostCentreProblem("")).toBe(PICK_COST_CENTRE);
    expect(bookingCostCentreProblem("l1")).toBeNull();
  });
});

describe("addableCostCentres", () => {
  it("offers the company cost centres the job has no line for", () => {
    const lines = [
      { id: "l1", name: "Sewer", cost_centre_id: DRAIN },
      // An untagged Simpro line counts by name.
      { id: "l2", name: "transport ", cost_centre_id: null },
    ];
    expect(addableCostCentres(lines, company).map((c) => c.id)).toEqual([CIVIL]);
  });
});

describe("picker values", () => {
  it("round-trip", () => {
    expect(parseCostCentreChoice(costCentreChoiceValue({ kind: "line", id: "l1" }))).toEqual({ kind: "line", id: "l1" });
    expect(parseCostCentreChoice(costCentreChoiceValue({ kind: "add", costCentreId: CIVIL }))).toEqual({ kind: "add", costCentreId: CIVIL });
    expect(parseCostCentreChoice("line:")).toBeNull();
    expect(parseCostCentreChoice(null)).toBeNull();
  });
  it("label a line by name and PO, never an amount", () => {
    expect(lineLabel({ name: "Transport", po_number: "4321-1" })).toBe("Transport (PO 4321-1)");
    expect(lineLabel({ name: "Transport", po_number: null })).toBe("Transport");
  });
});

describe("planBookingLine", () => {
  const civil = company[2];
  it("reuses a line already tagged with the cost centre (a retry adds nothing)", () => {
    const pos = [
      { id: "po1", po_number: "4321-1", lines: [{ id: "l1", name: "Sewer", cost_centre_id: DRAIN, sort_order: 0 }] },
      { id: "po2", po_number: "4321-2", lines: [{ id: "l9", name: "Civil works", cost_centre_id: CIVIL, sort_order: 0 }] },
    ];
    expect(planBookingLine({ pos, centre: civil, newPoNumber: "4321-3" })).toEqual({ kind: "existing", lineId: "l9" });
  });
  it("adds a $0 line to the job's FIRST PO, after its last line", () => {
    const pos = [
      { id: "po1", po_number: "4321-1", lines: [{ id: "l1", name: "Sewer", cost_centre_id: DRAIN, sort_order: 4 }] },
      { id: "po2", po_number: "4321-2", lines: [] },
    ];
    expect(planBookingLine({ pos, centre: civil, newPoNumber: "4321-3" })).toEqual({
      kind: "add-line",
      poId: "po1",
      line: { cost_centre_id: CIVIL, name: "Civil", allocated_amount: 0, allocated_hours: 0, sort_order: 5 },
    });
  });
  it("makes the job's PO first when it has none", () => {
    expect(planBookingLine({ pos: [], centre: civil, newPoNumber: "4321-1" })).toEqual({
      kind: "new-po",
      poNumber: "4321-1",
      line: { cost_centre_id: CIVIL, name: "Civil", allocated_amount: 0, allocated_hours: 0, sort_order: 0 },
    });
  });
});

describe("planTodoDrop carries the cost centre picked in the drop's confirm", () => {
  it("sets it on the booking", () => {
    expect(planTodoDrop({ jobId: "j1", staffId: "dave", dateKey: "2026-11-20", estimateHours: null, costCenterId: "l1" }).cost_center_id).toBe("l1");
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs/[id]/booking-cost-centre
// ---------------------------------------------------------------------------

const guard = vi.fn();
const callerClient = vi.fn();
const adminClient = vi.fn();
vi.mock("@/lib/api/guards", () => ({ requireOfficeOrAdmin: (...a: unknown[]) => guard(...a) }));
vi.mock("@/lib/api/caller-client", () => ({ callerClient: (...a: unknown[]) => callerClient(...a) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: (...a: unknown[]) => adminClient(...a) }));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));

import { POST } from "@/app/api/jobs/[id]/booking-cost-centre/route";

const JOB = "11111111-1111-4111-8111-111111111111";
const CC = "66666666-6666-4666-8666-666666666666";
const PO_ID = "22222222-2222-4222-8222-222222222222";

interface Op {
  table: string;
  action: "select" | "insert" | "update";
  payload?: unknown;
  filters: [string, unknown[]][];
}

function fakeClient(tables: Record<string, unknown[]>) {
  const ops: Op[] = [];
  let n = 0;
  const from = (table: string) => {
    const op: Op = { table, action: "select", filters: [] };
    ops.push(op);
    const answer = (single: boolean) => {
      if (op.action === "insert") return { data: { id: `new-${table}-${++n}` }, error: null };
      if (op.action === "update") return { data: null, error: null };
      let rows = tables[table] ?? [];
      for (const [m, args] of op.filters) if (m === "eq") rows = rows.filter((r) => (r as Record<string, unknown>)[args[0] as string] === args[1]);
      return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
    };
    const chain: Record<string, unknown> = {};
    for (const m of ["eq", "is", "order"]) chain[m] = (...args: unknown[]) => (op.filters.push([m, args]), chain);
    chain.select = () => chain;
    chain.insert = (payload: unknown) => ((op.action = "insert"), (op.payload = payload), chain);
    chain.update = (payload: unknown) => ((op.action = "update"), (op.payload = payload), chain);
    chain.maybeSingle = async () => answer(true);
    chain.single = async () => answer(true);
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(answer(false)).then(resolve, reject);
    return chain;
  };
  return { client: { from }, ops };
}

const req = (body: unknown) =>
  new NextRequest("https://app.test/api/x", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const ctx = { params: Promise.resolve({ id: JOB }) };

describe("POST /api/jobs/[id]/booking-cost-centre", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guard.mockResolvedValue({ ok: true, userId: "office-user", role: "office" });
  });

  it("refuses anyone but office/admin before touching the database", async () => {
    guard.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) });
    const res = await POST(req({ costCentreId: CC }), ctx);
    expect(res.status).toBe(403);
    expect(callerClient).not.toHaveBeenCalled();
    expect(adminClient).not.toHaveBeenCalled();
  });

  it("makes the job's <n>-1 PO at $0, adds the line, and tags the bookings with none — as the caller", async () => {
    const fake = fakeClient({
      jobs: [{ id: JOB, job_number: 4321 }],
      cost_centres: [{ id: CC, name: "Civil" }],
      purchase_orders: [],
    });
    callerClient.mockResolvedValue(fake.client);
    const res = await POST(req({ costCentreId: CC, poId: PO_ID, applyToBookings: true }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.line).toEqual({ id: "new-po_cost_centers-2", name: "Civil", cost_centre_id: CC, po_number: "4321-1" });
    const po = fake.ops.find((o) => o.table === "purchase_orders" && o.action === "insert");
    expect(po?.payload).toEqual({ id: PO_ID, job_id: JOB, po_number: "4321-1", total_value: 0, total_hours: 0 });
    const line = fake.ops.find((o) => o.table === "po_cost_centers" && o.action === "insert");
    expect(line?.payload).toMatchObject({ po_id: "new-purchase_orders-1", cost_centre_id: CC, allocated_amount: 0, allocated_hours: 0 });
    const tag = fake.ops.find((o) => o.table === "job_bookings" && o.action === "update");
    expect(tag?.payload).toEqual({ cost_center_id: "new-po_cost_centers-2" });
    expect(tag?.filters).toContainEqual(["is", ["cost_center_id", null]]);
    expect(adminClient).not.toHaveBeenCalled();
    // Names and ids only.
    expect(JSON.stringify(body)).not.toMatch(/amount|value|rate|\$/i);
  });

  it("reuses the job's line for that cost centre and writes nothing", async () => {
    const fake = fakeClient({
      jobs: [{ id: JOB, job_number: 4321 }],
      cost_centres: [{ id: CC, name: "Civil" }],
      purchase_orders: [{ id: PO_ID, job_id: JOB, po_number: "4321-1", po_cost_centers: [{ id: "line-x", name: "Civil works", cost_centre_id: CC, sort_order: 0 }] }],
    });
    callerClient.mockResolvedValue(fake.client);
    const res = await POST(req({ costCentreId: CC }), ctx);
    const body = await res.json();
    expect(body).toEqual({ line: { id: "line-x", name: "Civil works", cost_centre_id: CC, po_number: "4321-1" }, added: false });
    expect(fake.ops.some((o) => o.action !== "select")).toBe(false);
  });

  it("answers a bad request with a fixed sentence", async () => {
    const res = await POST(req({ costCentreId: "nope" }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Pick a cost centre for this job.");
  });
});
