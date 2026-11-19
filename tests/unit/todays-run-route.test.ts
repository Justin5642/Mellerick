import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// GET /api/runs/today — the truck driver's run sheet.
//
// What matters, in order:
//   1. THE MONEY RULE (HANDOVER §2). The route reads truck rates (through
//      loadCartageLists) and the job's PO lines (office-only, they carry
//      money) through the service role. The answer must carry no money-named
//      key and no rate or amount value at any depth — for a technician, and
//      for the office too (the run sheet is quantities only).
//   2. Only the caller's OWN cartage bookings booked today make the run.
//   3. The service role reads po_cost_centers only for those bookings' ids,
//      and never an amount column.
//   4. Before 0111: { ready: false }, never an error.

const requireRole = vi.fn();
vi.mock("@/lib/api/guards", () => ({ requireRole: (...a: unknown[]) => requireRole(...a) }));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));

const ME = "tech-1";
const JOB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const JOB_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TIPPER = "22222222-2222-4222-8222-222222222222";

const PER_TONNE = 28.37;
const PER_KM = 3.19;
const ALLOCATED = 9876.54;

type Call = [string, unknown[]];
interface Query {
  client: "admin" | "caller";
  table: string;
  calls: Call[];
}
const queries: Query[] = [];
let loadsMissing = false;
let bookings: Record<string, unknown>[] = [];
let loads: Record<string, unknown>[] = [];

const arg = (q: Query, m: string, col: string) => q.calls.find(([c, a]) => c === m && a[0] === col)?.[1][1];

const JOBS: Record<string, Record<string, unknown>> = {
  [JOB_A]: { id: JOB_A, job_number: 801, title: "Lot 4 drainage", status: "in_progress", quarry_included: null, customers: { name: "Acme Homes" }, sites: { name: "Lot 4", address_line1: "12 Smith St", suburb: "Craigieburn", state: "VIC", site_lat: -37.6, site_lng: 144.9 } },
  [JOB_B]: { id: JOB_B, job_number: 802, title: "Lot 9", status: "scheduled", quarry_included: false, customers: { name: "Acme Homes" }, sites: { name: "Lot 9", address_line1: "3 Jones Rd", suburb: "Mickleham", state: "VIC", site_lat: null, site_lng: null } },
  [JOB_C]: { id: JOB_C, job_number: 790, title: "Added job", status: "in_progress", quarry_included: null, customers: null, sites: null },
  [JOB_D]: { id: JOB_D, job_number: 795, title: "Other open job", status: "pending", customers: { name: "B Builder" }, sites: { name: "Lot 1", address_line1: "1 High St", suburb: "Wollert" } },
};

function resolve(q: Query): { data?: unknown; error?: unknown } {
  switch (q.table) {
    case "job_bookings":
      return { data: bookings.filter((b) => b.staff_id === arg(q, "eq", "staff_id")), error: null };
    case "po_cost_centers": {
      const ids = arg(q, "in", "id") as string[];
      const all = [
        { id: "line-transport", name: "Cartage", allocated_amount: ALLOCATED, cost_centres: { name: "Transport" } },
        { id: "line-drain", name: "Sewer", allocated_amount: ALLOCATED, cost_centres: { name: "Below Ground Drainage" } },
      ];
      return { data: all.filter((l) => ids.includes(l.id)), error: null };
    }
    case "cartage_loads":
      if (loadsMissing) return { data: null, error: { code: "42P01", message: "relation does not exist" } };
      return { data: loads.filter((l) => l.load_date === arg(q, "eq", "load_date")).map((l) => ({ ...l, profiles: { full_name: "Dan Driver" } })), error: null };
    case "jobs": {
      const ids = arg(q, "in", "id") as string[] | undefined;
      if (ids) return { data: ids.map((id) => JOBS[id]).filter(Boolean), error: null };
      if (arg(q, "eq", "assigned_to") === ME) return { data: [JOBS[JOB_A], JOBS[JOB_D]], error: null };
      if (arg(q, "eq", "job_assignments.staff_id") === ME) return { data: [JOBS[JOB_B], JOBS[JOB_C], JOBS[JOB_D]], error: null };
      return { data: [], error: null };
    }
    case "equipment":
      return {
        data: [
          {
            id: TIPPER,
            name: "Isuzu tipper",
            is_active: true,
            category: "vehicle",
            equipment_hire_options: [
              { hire_type: "cartage", hire_unit: "tonne", rate: PER_TONNE, is_active: true },
              { hire_type: "cartage", hire_unit: "km", rate: PER_KM, is_active: true },
            ],
          },
        ],
        error: null,
      };
    case "suppliers":
      return { data: [{ id: "q1", name: "Northern Quarries", pin_order: 1 }], error: null };
    case "cost_centres":
      return { data: [{ id: "cc-t", name: "Transport" }], error: null };
  }
  return { data: null, error: null };
}

function fakeClient(client: "admin" | "caller") {
  return {
    from(table: string) {
      const q: Query = { client, table, calls: [] };
      queries.push(q);
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "lt", "or", "not", "in", "order", "limit"]) {
        chain[m] = (...a: unknown[]) => {
          q.calls.push([m, a]);
          return chain;
        };
      }
      chain.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve(q)).then(ok, bad);
      return chain;
    },
  };
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeClient("admin") }));
vi.mock("@/lib/api/caller-client", () => ({ callerClient: async () => fakeClient("caller") }));

import { GET } from "@/app/api/runs/today/route";

const req = () => new NextRequest("http://test.local/api/runs/today");
const as = (role: string) => requireRole.mockResolvedValue({ ok: true, userId: ME, role });

const TODAY = "2026-11-19";
const booking = (over: Record<string, unknown>) => ({
  id: "b1",
  job_id: JOB_A,
  staff_id: ME,
  cost_center_id: "line-transport",
  starts_at: "2026-11-18T20:00:00.000Z",
  ends_at: "2026-11-19T04:30:00.000Z",
  daily: false,
  all_day: true,
  ...over,
});
const load = (over: Record<string, unknown>) => ({
  id: "l1",
  job_id: JOB_A,
  equipment_id: TIPPER,
  load_date: TODAY,
  direction: "material_in",
  material: "Crushed rock",
  supplier_id: "q1",
  place: "Northern Quarries",
  from_text: null,
  to_text: null,
  quantity: "12.00",
  unit: "tonne",
  km: "30.0",
  docket_number: "D1",
  docket_photo_path: `${JOB_A}/expense-receipt-cartage-l1-1.jpg`,
  billing: "included",
  cost_centre_id: "cc-t",
  status: "draft",
  signer_name: null,
  signature_path: null,
  signed_at: null,
  invoice_id: null,
  void_reason: null,
  created_by: ME,
  ...over,
});

const MONEY_KEY = /(rate|cost|price|amount|total|charge|fee|value|base|per_km|pricing|gst|margin|lines|docketphoto|allocated)/i;
// Quantity totals and the cost centre's NAME are not money.
const NOT_MONEY = new Set(["cost_centre", "costCentre", "totals"]);
function moneyIn(v: unknown, path = "body", out = { keys: [] as string[], numbers: [] as number[], strings: [] as string[] }) {
  if (Array.isArray(v)) v.forEach((x, i) => moneyIn(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (MONEY_KEY.test(k) && !NOT_MONEY.has(k)) out.keys.push(`${path}.${k}`);
      moneyIn(x, `${path}.${k}`, out);
    }
  } else if (typeof v === "number") out.numbers.push(v);
  else if (typeof v === "string") out.strings.push(v);
  return out;
}
function expectNoMoney(body: unknown) {
  const out = moneyIn(body);
  expect(out.keys).toEqual([]);
  for (const r of [PER_TONNE, PER_KM, ALLOCATED]) expect(out.numbers).not.toContain(r);
  expect(out.strings.filter((s) => s.includes("expense-receipt"))).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T00:00:00.000Z")); // 11:00 in Melbourne
  queries.length = 0;
  loadsMissing = false;
  bookings = [];
  loads = [];
});
afterEach(() => vi.useRealTimers());

describe("Today's run", () => {
  it("lists only the caller's own cartage jobs booked today, in booking order, with today's loads and totals", async () => {
    bookings = [
      booking({ id: "b-late", job_id: JOB_A, starts_at: "2026-11-19T02:00:00.000Z", ends_at: "2026-11-19T04:00:00.000Z", all_day: false }),
      booking({ id: "b-early", job_id: JOB_B, starts_at: "2026-11-18T20:00:00.000Z", ends_at: "2026-11-18T23:00:00.000Z", all_day: false }),
      booking({ id: "b-a-again", job_id: JOB_A, starts_at: "2026-11-19T00:00:00.000Z", ends_at: "2026-11-19T01:00:00.000Z", all_day: false }),
      booking({ id: "b-drain", job_id: JOB_D, cost_center_id: "line-drain" }),
      booking({ id: "b-other", staff_id: "tech-2", job_id: JOB_D }),
    ];
    loads = [
      load({ id: "l1" }),
      load({ id: "l2", direction: "spoil_out", material: null, supplier_id: null, place: "Wollert tip", unit: "m3", quantity: "9", km: "20", billing: "extra", docket_photo_path: null }),
      load({ id: "l-void", status: "void", quantity: "50" }),
      load({ id: "l-yesterday", load_date: "2026-11-18" }),
      // Another driver's load on a job not on my run: not mine, not shown.
      load({ id: "l-not-mine", job_id: JOB_D, created_by: "tech-2" }),
    ];
    as("technician");
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ready: true, date: TODAY });
    expect(body.jobs.map((j: { jobNumber: number }) => j.jobNumber)).toEqual([802, 801]);
    const [b, a] = body.jobs;
    expect(b).toMatchObject({ booked: true, siteLabel: "3 Jones Rd, Mickleham", defaults: { material_in: "extra", spoil_out: "extra" }, loads: [] });
    expect(a.slots.map((s: { bookingId: string }) => s.bookingId)).toEqual(["b-a-again", "b-late"]);
    expect(a.slots[0]).toMatchObject({ costCentre: "Transport", stage: "Cartage" });
    expect(a.site).toEqual({ address_line1: "12 Smith St", suburb: "Craigieburn", state: "VIC", site_lat: -37.6, site_lng: 144.9 });
    expect(a.loads.map((l: { id: string }) => l.id)).toEqual(["l1", "l2", "l-void"]);
    expect(a.totals.in).toMatchObject({ trips: 1, tonnes: 12, km: 30, materials: ["Crushed rock"] });
    expect(a.totals.out).toMatchObject({ trips: 1, m3: 9, km: 20 });
    expect(body.totals).toMatchObject({ trips: 2, tonnes: 12, m3: 9, km: 50 });
    expect(body.trucks).toEqual([{ id: TIPPER, name: "Isuzu tipper" }]);
    expect(body.suppliers).toEqual([{ id: "q1", name: "Northern Quarries", pinOrder: 1 }]);
    // "+ Add a job": my own open jobs not already on the run.
    expect(body.otherJobs.map((j: { jobNumber: number }) => j.jobNumber)).toEqual([795, 790]);
    expectNoMoney(body);
  });

  it("the office's answer carries no money either", async () => {
    bookings = [booking({})];
    loads = [load({ billing: "extra", direction: "spoil_out", unit: "tonne" })];
    as("office");
    const body = await (await GET(req())).json();
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].loads[0].has_docket_photo).toBe(true);
    expectNoMoney(body);
    // Costs and the margin are never even read.
    expect(queries.some((q) => q.table === "cartage_load_costs" || q.table === "billing_rate_config")).toBe(false);
  });

  it("a job I logged a load on today without a booking joins the run after the booked ones", async () => {
    bookings = [booking({})];
    loads = [load({ id: "lc", job_id: JOB_C })];
    as("technician");
    const body = await (await GET(req())).json();
    expect(body.jobs.map((j: { id: string; booked: boolean }) => [j.id, j.booked])).toEqual([
      [JOB_A, true],
      [JOB_C, false],
    ]);
    expect(body.otherJobs.map((j: { id: string }) => j.id)).toEqual([JOB_B, JOB_D]);
  });

  it("reads bookings and loads as the caller, and PO lines with the service role only for the caller's booking lines, never an amount", async () => {
    bookings = [booking({}), booking({ id: "b2", cost_center_id: "line-drain" })];
    as("technician");
    await GET(req());
    for (const t of ["job_bookings", "cartage_loads", "jobs"]) {
      expect(queries.filter((q) => q.table === t).every((q) => q.client === "caller")).toBe(true);
    }
    const lineReads = queries.filter((q) => q.table === "po_cost_centers");
    expect(lineReads).toHaveLength(1);
    expect(lineReads[0].client).toBe("admin");
    expect(arg(lineReads[0], "in", "id")).toEqual(["line-transport", "line-drain"]);
    expect(String(lineReads[0].calls.find(([c]) => c === "select")![1][0])).not.toMatch(/amount|hours/);
    expect(arg(queries.find((q) => q.table === "job_bookings")!, "eq", "staff_id")).toBe(ME);
  });

  it("no cartage booking today: an empty run (My Jobs shows no card)", async () => {
    bookings = [booking({ cost_center_id: "line-drain" })];
    as("technician");
    const body = await (await GET(req())).json();
    expect(body.ready).toBe(true);
    expect(body.jobs).toEqual([]);
    expect(queries.some((q) => q.table === "po_cost_centers")).toBe(true);
  });

  it("before 0111: ready false with the booked count, never an error", async () => {
    loadsMissing = true;
    bookings = [booking({})];
    as("technician");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: false, date: TODAY, jobCount: 1 });
  });

  it("refused callers get the guard's answer", async () => {
    requireRole.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 }) });
    expect((await GET(req())).status).toBe(401);
    expect(queries).toHaveLength(0);
  });

  it("?summary=1 (My Jobs' card) counts the open cartage jobs booked today and reads nothing else", async () => {
    bookings = [
      booking({ id: "b1", job_id: JOB_A }),
      booking({ id: "b2", job_id: JOB_B, starts_at: "2026-11-19T02:00:00.000Z", ends_at: "2026-11-19T03:00:00.000Z", all_day: false }),
      booking({ id: "b-drain", job_id: JOB_D, cost_center_id: "line-drain" }),
      booking({ id: "b-tomorrow", job_id: JOB_C, starts_at: "2026-11-19T20:00:00.000Z", ends_at: "2026-11-20T04:30:00.000Z" }),
    ];
    loads = [load({})];
    as("technician");
    const res = await GET(new NextRequest("http://test.local/api/runs/today?summary=1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true, date: TODAY, jobCount: 2 });
    expect(queries.map((q) => q.table).sort()).toEqual(["job_bookings", "jobs", "po_cost_centers"]);
  });

  it("?summary=1 leaves out a closed job", async () => {
    JOBS[JOB_B].status = "completed";
    try {
      bookings = [booking({ id: "b1", job_id: JOB_A }), booking({ id: "b2", job_id: JOB_B })];
      as("technician");
      expect(await (await GET(new NextRequest("http://test.local/api/runs/today?summary=1"))).json()).toEqual({ ready: true, date: TODAY, jobCount: 1 });
    } finally {
      JOBS[JOB_B].status = "scheduled";
    }
  });

  it("each job offered by '+ Add a job' carries the job's included/extra defaults for the form", async () => {
    as("technician");
    const body = await (await GET(req())).json();
    const b = body.otherJobs.find((j: { id: string }) => j.id === JOB_B);
    expect(b).toMatchObject({ quarryIncluded: false, defaults: { material_in: "extra", spoil_out: "extra" } });
    const d = body.otherJobs.find((j: { id: string }) => j.id === JOB_D);
    expect(d).toMatchObject({ quarryIncluded: null, defaults: { material_in: "included", spoil_out: "extra" } });
    expectNoMoney(body);
  });
});
