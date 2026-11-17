import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Truck loads (0111) under /api/jobs/[id]/cartage-loads, and the loads half of
// Invoice Day Works.
//
// What matters, in order:
//   1. THE MONEY RULE (HANDOVER §2). The routes read truck rates, docket costs
//      and the margin through the service role. A technician's answers must
//      carry no money-named key and no rate, cost, margin or price value at
//      any depth — and no docket photo URL (a docket shows prices).
//   2. Writes to the load go through the CALLER's client (RLS + 0111's
//      trigger), never the service role — except the docket photo, which
//      goes up with the service role to a money-document path.
//   3. An extra load that can't be priced is never invoiced at $0.

const requireOnJob = vi.fn();
const requireOfficeOrAdmin = vi.fn();
vi.mock("@/lib/api/guards", () => ({
  requireOnJob: (...a: unknown[]) => requireOnJob(...a),
  requireOfficeOrAdmin: (...a: unknown[]) => requireOfficeOrAdmin(...a),
}));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));

const JOB = "11111111-1111-4111-8111-111111111111";
const TIPPER = "22222222-2222-4222-8222-222222222222";
const LOAD = "33333333-3333-4333-8333-333333333333";
const LOAD2 = "44444444-4444-4444-8444-444444444444";
const QUARRY = "55555555-5555-4555-8555-555555555555";

// Figures chosen so each is recognisable by value in a payload.
const PER_TONNE = 28.37;
const PER_KM = 3.19;
const TIP_FEE = 181.13;
const MARGIN = 17.5;
const MONEY_VALUES = [PER_TONNE, PER_KM, TIP_FEE, MARGIN];

type Call = [string, unknown[]];
interface Query {
  client: "admin" | "caller";
  table: string;
  calls: Call[];
  single: boolean;
}
type Result = { data?: unknown; error?: unknown; count?: number | null };

const queries: Query[] = [];
const uploads: { client: string; path: string }[] = [];
const removed: string[][] = [];
let loads: Record<string, unknown>[] = [];
let costs: Record<string, unknown>[] = [];
const invoices: Record<string, unknown>[] = [];

const arg = (q: Query, m: string, col: string) => q.calls.find(([c, a]) => c === m && a[0] === col)?.[1][1];
const method = (q: Query) => q.calls.find(([m]) => ["insert", "update", "delete", "upsert"].includes(m))?.[0] ?? "select";

function matchLoads(q: Query) {
  const id = arg(q, "eq", "id");
  const ids = arg(q, "in", "id") as string[] | undefined;
  const job = arg(q, "eq", "job_id");
  const status = arg(q, "eq", "status");
  return loads.filter((r) => (id === undefined || r.id === id) && (!ids || ids.includes(r.id as string)) && (job === undefined || r.job_id === job) && (status === undefined || r.status === status));
}

function resolve(q: Query): Result {
  const m = method(q);
  switch (q.table) {
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
          { id: "saw", name: "Concrete saw", is_active: true, category: "tool", equipment_hire_options: [] },
        ],
        error: null,
      };
    case "equipment_hire_options":
      return {
        data: [
          { equipment_id: TIPPER, hire_type: "cartage", hire_unit: "tonne", rate: PER_TONNE, is_active: true },
          { equipment_id: TIPPER, hire_type: "cartage", hire_unit: "km", rate: PER_KM, is_active: true },
        ],
        error: null,
      };
    case "suppliers":
      return { data: [{ id: QUARRY, name: "Northern Quarries", pin_order: 1 }], error: null };
    case "cost_centres":
      return { data: [{ id: "cc-t", name: "Transport" }], error: null };
    case "jobs":
      return { data: { id: JOB, customer_id: "cust", job_number: 812, quarry_included: null, sites: { name: "Lot 4", address_line1: "12 Smith St", suburb: "Craigieburn" } }, error: null };
    case "billing_rate_config":
      return { data: { cartage_margin_pct: MARGIN }, error: null };
    case "cartage_load_costs":
      return { data: costs, error: null };
    case "hire_entries":
      return { data: [], error: null };
    case "invoices": {
      if (m === "insert") {
        const row = { id: "inv-1", invoice_number: "INV-9", ...(q.calls.find(([c]) => c === "insert")![1][0] as object) };
        invoices.push(row);
        return { data: row, error: null };
      }
      return { error: null };
    }
    case "invoice_items":
      return { error: null };
    case "cartage_loads": {
      if (m === "insert") {
        const row = q.calls.find(([c]) => c === "insert")![1][0] as Record<string, unknown>;
        loads.push({ status: "draft", billing: row.billing ?? (row.direction === "spoil_out" ? "extra" : "included"), cost_centre_id: "cc-t", docket_photo_path: null, signer_name: null, signature_path: null, signed_at: null, invoice_id: null, void_reason: null, created_by: "tech-1", ...row });
        return { error: null };
      }
      if (m === "update") {
        const patch = q.calls.find(([c]) => c === "update")![1][0] as object;
        const hit = matchLoads(q);
        hit.forEach((r) => Object.assign(r, patch));
        return { data: hit.map((r) => ({ id: r.id })), error: null, count: hit.length };
      }
      if (m === "delete") {
        const hit = matchLoads(q);
        loads = loads.filter((r) => !hit.includes(r));
        return { error: null, count: hit.length };
      }
      const hit = matchLoads(q).map((r) => ({ ...r, profiles: { full_name: "Dan Driver" } }));
      return q.single ? { data: hit[0] ?? null, error: null } : { data: hit, error: null };
    }
  }
  return { data: null, error: null };
}

function fakeClient(client: "admin" | "caller") {
  return {
    from(table: string) {
      const q: Query = { client, table, calls: [], single: false };
      queries.push(q);
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "in", "order", "limit"]) {
        chain[m] = (...a: unknown[]) => {
          q.calls.push([m, a]);
          return chain;
        };
      }
      chain.maybeSingle = async () => {
        q.single = true;
        return resolve(q);
      };
      chain.single = chain.maybeSingle;
      chain.then = (ok: (v: Result) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve(q)).then(ok, bad);
      return chain;
    },
    storage: {
      from: () => ({
        upload: async (path: string) => {
          uploads.push({ client, path });
          return { error: null };
        },
        remove: async (paths: string[]) => {
          removed.push(paths);
          return { error: null };
        },
        createSignedUrls: async (paths: string[]) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://signed.example/${p}` })), error: null }),
      }),
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeClient("admin") }));
vi.mock("@/lib/api/caller-client", () => ({ callerClient: async () => fakeClient("caller") }));

import { GET, POST } from "@/app/api/jobs/[id]/cartage-loads/route";
import { PATCH } from "@/app/api/jobs/[id]/cartage-loads/[loadId]/route";
import { POST as SIGN } from "@/app/api/jobs/[id]/cartage-loads/sign/route";
import { POST as DOCKET } from "@/app/api/jobs/[id]/cartage-loads/[loadId]/docket/route";
import { POST as INVOICE } from "@/app/api/jobs/[id]/hire-entries/invoice/route";

const ctx = { params: Promise.resolve({ id: JOB }) };
const loadCtx = (loadId = LOAD) => ({ params: Promise.resolve({ id: JOB, loadId }) });
const req = (m: string, body?: unknown) =>
  new NextRequest(`http://test.local/api/jobs/${JOB}/cartage-loads`, { method: m, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const asTech = () => requireOnJob.mockResolvedValue({ ok: true, userId: "tech-1", role: "technician" });
const asOffice = () => {
  requireOnJob.mockResolvedValue({ ok: true, userId: "office-1", role: "office" });
  requireOfficeOrAdmin.mockResolvedValue({ ok: true, userId: "office-1", role: "office" });
};

const spoilBody = { id: LOAD, equipment_id: TIPPER, load_date: "2026-11-17", direction: "spoil_out", place: "Wollert tip", quantity: 12, unit: "tonne", km: 35, docket_number: "T1234" };
const loadRow = (over: Record<string, unknown> = {}) => ({
  id: LOAD,
  job_id: JOB,
  equipment_id: TIPPER,
  load_date: "2026-11-17",
  direction: "spoil_out",
  material: null,
  supplier_id: null,
  place: "Wollert tip",
  from_text: null,
  to_text: null,
  quantity: "12.00",
  unit: "tonne",
  km: "35.0",
  docket_number: "T1234",
  docket_photo_path: `${JOB}/expense-receipt-cartage-${LOAD}-1.jpg`,
  billing: "extra",
  cost_centre_id: "cc-t",
  status: "draft",
  signer_name: null,
  signature_path: null,
  signed_at: null,
  invoice_id: null,
  void_reason: null,
  created_by: "tech-1",
  ...over,
});

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(200).fill(7)]).toString("base64");

const MONEY_KEY = /(rate|cost|price|amount|total|charge|fee|value|base|per_km|pricing|gst|margin|lines|docketphoto)/i;
const NOT_MONEY = new Set(["cost_centre"]);
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
  // 12 × 28.37 + 181.13 × 1.175 + 35 × 3.19
  const total = Math.round((12 * PER_TONNE + Math.round(TIP_FEE * (1 + MARGIN / 100) * 100) / 100 + 35 * PER_KM) * 100) / 100;
  for (const r of [...MONEY_VALUES, total]) expect(out.numbers).not.toContain(r);
  expect(out.strings.filter((s) => s.includes("expense-receipt"))).toEqual([]);
}
const writesBy = (client: "admin" | "caller", table: string) => queries.filter((q) => q.client === client && q.table === table && method(q) !== "select");

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  uploads.length = 0;
  removed.length = 0;
  invoices.length = 0;
  loads = [];
  costs = [];
});

describe("Truck loads — the money rule", () => {
  it("a technician's GET carries no rate, cost, margin, price or docket photo", async () => {
    loads = [loadRow()];
    costs = [{ load_id: LOAD, docket_cost_ex_gst: TIP_FEE, margin_pct: null }];
    asTech();
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.pricing).toBeUndefined();
    expect(body.loads[0]).toMatchObject({ id: LOAD, has_docket_photo: true, billing: "extra", quantity: 12 });
    expect(body.trucks).toEqual([{ id: TIPPER, name: "Isuzu tipper" }]);
    expectNoMoney(body);
    // Costs and the margin are never even read for a technician.
    expect(queries.some((q) => q.table === "cartage_load_costs" || q.table === "billing_rate_config")).toBe(false);
  });

  it("a technician's POST answer carries no money either", async () => {
    costs = [{ load_id: LOAD, docket_cost_ex_gst: TIP_FEE, margin_pct: null }];
    asTech();
    const res = await POST(req("POST", spoilBody), ctx);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.saved).toEqual({ id: LOAD });
    expectNoMoney(body);
  });

  it("the office's GET prices the extra with its breakdown", async () => {
    loads = [loadRow()];
    costs = [{ load_id: LOAD, docket_cost_ex_gst: TIP_FEE, margin_pct: null }];
    asOffice();
    const body = await (await GET(req("GET"), ctx)).json();
    const p = body.pricing.loads[LOAD];
    expect(body.pricing.companyMarginPct).toBe(MARGIN);
    expect(p.docketCost).toBe(TIP_FEE);
    expect(p.lines).toHaveLength(3);
    expect(p.total).toBe(Math.round((12 * PER_TONNE + Math.round(TIP_FEE * 1.175 * 100) / 100 + 35 * PER_KM) * 100) / 100);
    expect(p.docketPhotoUrl).toContain("expense-receipt-cartage");
  });
});

describe("Truck loads — writes", () => {
  it("adds through the caller's client, and a retry with the same id adds nothing", async () => {
    asTech();
    expect((await POST(req("POST", spoilBody), ctx)).status).toBe(201);
    expect((await POST(req("POST", spoilBody), ctx)).status).toBe(200);
    expect(loads).toHaveLength(1);
    expect(writesBy("caller", "cartage_loads")).toHaveLength(1);
    expect(writesBy("admin", "cartage_loads")).toHaveLength(0);
    // Billing left to the database's default when the phone didn't choose.
    expect((writesBy("caller", "cartage_loads")[0].calls.find(([c]) => c === "insert")![1][0] as object)).not.toHaveProperty("billing");
  });

  it("refuses a bare 'load' of spoil charged as extra, before any write", async () => {
    asTech();
    const res = await POST(req("POST", { ...spoilBody, unit: "load" }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/tonne or m³/);
    expect(loads).toHaveLength(0);
  });

  it("a signed load can't be edited", async () => {
    loads = [loadRow({ status: "signed" })];
    asTech();
    const res = await PATCH(req("PATCH", spoilBody), loadCtx());
    expect(res.status).toBe(409);
    expect(writesBy("caller", "cartage_loads")).toHaveLength(0);
  });

  it("signs the day's loads in one update with one signature", async () => {
    loads = [loadRow(), loadRow({ id: LOAD2, docket_photo_path: null })];
    asTech();
    const res = await SIGN(req("POST", { load_ids: [LOAD, LOAD2], signer_name: "Sam Builder", signature: PNG_B64 }), ctx);
    expect(res.status).toBe(200);
    expect(loads.every((l) => l.status === "signed" && l.signer_name === "Sam Builder")).toBe(true);
    expect(uploads).toEqual([{ client: "caller", path: expect.stringMatching(new RegExp(`^${JOB}/day-works/signature-loads-\\d+\\.png$`)) }]);
    expect(writesBy("caller", "cartage_loads")).toHaveLength(1);
    // A retry after a lost answer is answered as signed, with nothing new.
    const again = await SIGN(req("POST", { load_ids: [LOAD, LOAD2], signer_name: "Sam Builder", signature: PNG_B64 }), ctx);
    expect(again.status).toBe(200);
    expect(uploads).toHaveLength(1);
  });

  it("won't sign a load with no quantity", async () => {
    loads = [loadRow({ quantity: null })];
    asTech();
    const res = await SIGN(req("POST", { load_ids: [LOAD], signer_name: "Sam", signature: PNG_B64 }), ctx);
    expect(res.status).toBe(400);
    expect(uploads).toHaveLength(0);
  });

  it("the docket photo goes up with the service role to a money-document path, and the crew never get it back", async () => {
    loads = [loadRow({ docket_photo_path: null })];
    asTech();
    const res = await DOCKET(req("POST", { image: JPEG_B64 }), loadCtx());
    expect(res.status).toBe(200);
    expect(uploads).toEqual([{ client: "admin", path: expect.stringMatching(new RegExp(`^${JOB}/expense-receipt-cartage-${LOAD}-\\d+\\.jpg$`)) }]);
    expect(loads[0].docket_photo_path).toBe(uploads[0].path);
    const body = await res.json();
    expect(body.loads[0].has_docket_photo).toBe(true);
    expectNoMoney(body);
  });

  it("refuses a docket that isn't a picture", async () => {
    loads = [loadRow({ docket_photo_path: null })];
    asTech();
    const res = await DOCKET(req("POST", { image: Buffer.from("%PDF-1.7" + "x".repeat(200)).toString("base64") }), loadCtx());
    expect(res.status).toBe(400);
    expect(uploads).toHaveLength(0);
  });

  it("the crew can't attach a docket to a signed load", async () => {
    loads = [loadRow({ status: "signed", docket_photo_path: null })];
    asTech();
    expect((await DOCKET(req("POST", { image: JPEG_B64 }), loadCtx())).status).toBe(409);
    expect(uploads).toHaveLength(0);
  });
});

describe("Invoice Day Works — truck loads", () => {
  it("puts a signed extra on the invoice at its price and marks it invoiced", async () => {
    loads = [loadRow({ status: "signed", signer_name: "Sam Builder" })];
    costs = [{ load_id: LOAD, docket_cost_ex_gst: TIP_FEE, margin_pct: null }];
    asOffice();
    const res = await INVOICE(req("POST", { loadIds: [LOAD] }), ctx);
    expect(res.status).toBe(200);
    const items = queries.find((q) => q.table === "invoice_items")!.calls.find(([c]) => c === "insert")![1][0] as { name: string; unit_price: number }[];
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Spoil removal 12 t — 12 Smith St, Craigieburn → Wollert tip, docket T1234");
    expect(loads[0]).toMatchObject({ status: "invoiced", invoice_id: "inv-1" });
  });

  it("refuses an extra with no docket cost rather than invoicing it at $0", async () => {
    loads = [loadRow({ status: "signed", signer_name: "Sam" })];
    costs = [];
    asOffice();
    const res = await INVOICE(req("POST", { loadIds: [LOAD] }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/tip fee/);
    expect(invoices).toHaveLength(0);
  });

  it("refuses an included or unsigned load", async () => {
    loads = [loadRow({ status: "signed", billing: "included" }), loadRow({ id: LOAD2 })];
    asOffice();
    expect((await INVOICE(req("POST", { loadIds: [LOAD] }), ctx)).status).toBe(409);
    expect((await INVOICE(req("POST", { loadIds: [LOAD2] }), ctx)).status).toBe(409);
    expect(invoices).toHaveLength(0);
  });
});
