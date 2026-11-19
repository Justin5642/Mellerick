import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { parseServiceRecordBody, planHireOptionsSave, sniffFleetUpload, parseAttachmentPatch, serviceExpenseRow } from "@/lib/fleet-office";

// The phone's Fleet office routes (app/api/fleet/**): log a service with its
// invoice, delete one, hire setup, attachments, equipment documents.
//
// What matters:
//   1. requireOfficeOrAdmin first — a refused caller touches nothing.
//   2. Every write runs as the CALLER (callerClient), never the service role.
//   3. The web's order and clean-up: invoice upload → new cost → service; a
//      failed upload saves nothing; a failed service removes the cost and file.
//   4. Fixed error sentences (no database text).

const requireOfficeOrAdmin = vi.fn();
vi.mock("@/lib/api/guards", () => ({ requireOfficeOrAdmin: (...a: unknown[]) => requireOfficeOrAdmin(...a) }));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));
const adminConstructed = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { adminConstructed(); throw new Error("service role used"); } }));

const MACHINE = "11111111-1111-4111-8111-111111111111";
const RECORD = "22222222-2222-4222-8222-222222222222";
const EXPENSE = "33333333-3333-4333-8333-333333333333";
const ATTACH = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

type Result = { data?: unknown; error?: unknown; count?: number | null };
type Call = [string, unknown[]];
interface Q { table: string; calls: Call[] }
const log: string[] = [];
const queries: Q[] = [];
let resolve: (q: Q) => Result = () => ({ data: null, error: null });
const uploads: string[] = [];
const removed: string[][] = [];
let uploadError: unknown = null;

const op = (q: Q) => q.calls.find(([m]) => ["insert", "update", "delete", "upsert"].includes(m))?.[0] ?? "select";

function builder(table: string) {
  const q: Q = { table, calls: [] };
  queries.push(q);
  const p: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "in", "order", "single", "maybeSingle"]) {
    p[m] = (...a: unknown[]) => {
      q.calls.push([m, a]);
      if (["insert", "update", "delete", "upsert"].includes(m)) log.push(`${m}:${table}`);
      return p;
    };
  }
  p.then = (ok: (r: Result) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve(q)).then(ok, bad);
  return p;
}
const caller = {
  from: (t: string) => builder(t),
  storage: {
    from: () => ({
      upload: async (path: string) => { log.push("upload"); uploads.push(path); return { error: uploadError }; },
      remove: async (paths: string[]) => { log.push("remove-file"); removed.push(paths); return { data: paths, error: null }; },
    }),
  },
};
vi.mock("@/lib/api/caller-client", () => ({ callerClient: async () => caller }));

const req = (method: string, body?: unknown) =>
  new NextRequest("http://x/api", { method, headers: { authorization: "Bearer t", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = <T,>(p: T) => ({ params: Promise.resolve(p) });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");

beforeEach(() => {
  log.length = 0; queries.length = 0; uploads.length = 0; removed.length = 0; uploadError = null;
  requireOfficeOrAdmin.mockReset();
  requireOfficeOrAdmin.mockResolvedValue({ ok: true, userId: USER, role: "office" });
  adminConstructed.mockReset();
  resolve = (q) => {
    if (q.table === "equipment") return { data: { id: MACHINE }, error: null };
    if (q.table === "equipment_expenses" && op(q) === "insert") return { data: { id: EXPENSE, amount: 300 }, error: null };
    if (q.table === "equipment_service_records" && op(q) === "insert") return { data: { id: RECORD }, error: null };
    return { data: null, error: null };
  };
});

const SERVICE = { service_date: "2026-11-10", service_type: "scheduled", provider: "Truck Centre", odometer_km: "84000", expense: "new", amount: "300", gst_amount: "30", invoice: { fileBase64: JPEG, fileName: "inv 1.jpg" } };

describe("POST /api/fleet/[id]/service-records", () => {
  it("refuses a caller who isn't office/admin before touching anything", async () => {
    const { POST } = await import("@/app/api/fleet/[id]/service-records/route");
    requireOfficeOrAdmin.mockResolvedValue({ ok: false, response: new Response("no", { status: 403 }) });
    const res = await POST(req("POST", SERVICE), ctx({ id: MACHINE }));
    expect(res.status).toBe(403);
    expect(queries).toEqual([]);
    expect(uploads).toEqual([]);
  });

  it("uploads the invoice, then the cost, then the service — as the caller", async () => {
    const { POST } = await import("@/app/api/fleet/[id]/service-records/route");
    const res = await POST(req("POST", SERVICE), ctx({ id: MACHINE }));
    expect(res.status).toBe(200);
    expect(log).toEqual(["upload", "insert:equipment_expenses", "insert:equipment_service_records"]);
    expect(uploads[0]).toMatch(new RegExp(`^${MACHINE}/expense-receipt-\\d+_inv_1\\.jpg$`));
    const exp = queries.find((q) => q.table === "equipment_expenses" && op(q) === "insert")!;
    const row = exp.calls.find(([m]) => m === "insert")![1][0] as Record<string, unknown>;
    expect(row).toMatchObject({ equipment_id: MACHINE, category: "service", amount: 300, gst_amount: 30, receipt_storage_path: uploads[0], logged_by: USER });
    const rec = queries.find((q) => q.table === "equipment_service_records" && op(q) === "insert")!;
    expect(rec.calls.find(([m]) => m === "insert")![1][0]).toMatchObject({ expense_id: EXPENSE, odometer_km: 84000 });
    expect(adminConstructed).not.toHaveBeenCalled();
  });

  it("a failed upload saves nothing", async () => {
    const { POST } = await import("@/app/api/fleet/[id]/service-records/route");
    uploadError = { message: "denied" };
    const res = await POST(req("POST", SERVICE), ctx({ id: MACHINE }));
    expect(res.status).toBe(502);
    expect(log).toEqual(["upload"]);
    expect((await res.json()).error).toBe("The invoice file could not be uploaded. Nothing was saved.");
  });

  it("a failed service removes the cost and the file again, with a fixed sentence", async () => {
    const { POST } = await import("@/app/api/fleet/[id]/service-records/route");
    const base = resolve;
    resolve = (q) => {
      if (q.table === "equipment_service_records" && op(q) === "insert") return { data: null, error: { message: "violates check secret_column", code: "23514" } };
      if (q.table === "equipment_expenses" && op(q) === "delete") return { error: null, count: 1 };
      return base(q);
    };
    const res = await POST(req("POST", SERVICE), ctx({ id: MACHINE }));
    expect(res.status).toBe(500);
    expect(log).toEqual(["upload", "insert:equipment_expenses", "insert:equipment_service_records", "delete:equipment_expenses", "remove-file"]);
    expect(JSON.stringify(await res.json())).not.toContain("secret_column");
  });

  it("a retry of a service that already saved is answered as saved", async () => {
    const { POST } = await import("@/app/api/fleet/[id]/service-records/route");
    const base = resolve;
    resolve = (q) => (q.table === "equipment_service_records" && op(q) === "select" ? { data: { id: RECORD }, error: null } : base(q));
    const res = await POST(req("POST", { ...SERVICE, id: RECORD }), ctx({ id: MACHINE }));
    expect(await res.json()).toMatchObject({ replay: true, record: { id: RECORD } });
    expect(log).toEqual([]);
  });

  it("refuses a file that isn't a PDF or image", async () => {
    const { POST } = await import("@/app/api/fleet/[id]/service-records/route");
    const res = await POST(req("POST", { ...SERVICE, invoice: { fileBase64: Buffer.from("MZ...").toString("base64"), fileName: "x.exe" } }), ctx({ id: MACHINE }));
    expect(res.status).toBe(400);
    expect(log).toEqual([]);
  });
});

describe("DELETE /api/fleet/[id]/service-records/[recordId]", () => {
  it("a delete that matched nothing is refused, not reported done", async () => {
    const { DELETE } = await import("@/app/api/fleet/[id]/service-records/[recordId]/route");
    resolve = () => ({ error: null, count: 0 });
    const res = await DELETE(req("DELETE"), ctx({ id: MACHINE, recordId: RECORD }));
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/fleet/[id]/hire-options", () => {
  it("removes options no longer listed and upserts the rest", async () => {
    const { PUT } = await import("@/app/api/fleet/[id]/hire-options/route");
    resolve = (q) => {
      if (q.table === "equipment") return { data: { id: MACHINE }, error: null };
      if (q.table === "equipment_hire_options" && op(q) === "select") return { data: [{ id: "old", hire_type: "dry", hire_unit: "day" }], error: null };
      if (q.table === "equipment_hire_options" && op(q) === "delete") return { error: null, count: 1 };
      return { data: [], error: null };
    };
    const res = await PUT(req("PUT", { options: [{ hire_type: "cartage", hire_unit: "tonne", rate: "12.5" }] }), ctx({ id: MACHINE }));
    expect(res.status).toBe(200);
    expect(log).toEqual(["delete:equipment_hire_options", "upsert:equipment_hire_options"]);
  });
});

describe("hire attachments and documents", () => {
  it("PATCH with no matching row is refused", async () => {
    const { PATCH } = await import("@/app/api/fleet/hire-attachments/[attachmentId]/route");
    resolve = () => ({ data: null, error: null });
    const res = await PATCH(req("PATCH", { day_rate: 250 }), ctx({ attachmentId: ATTACH }));
    expect(res.status).toBe(404);
  });

  it("a document whose row fails removes the file again", async () => {
    const { POST } = await import("@/app/api/fleet/[id]/documents/route");
    const base = resolve;
    resolve = (q) => (q.table === "equipment_documents" ? { data: null, error: { message: "nope" } } : base(q));
    const res = await POST(req("POST", { fileBase64: JPEG, fileName: "rego.jpg" }), ctx({ id: MACHINE }));
    expect(res.status).toBe(500);
    expect(log).toEqual(["upload", "insert:equipment_documents", "remove-file"]);
  });

  it("an office caller's document is stored at <machine>/<ts>_<name>", async () => {
    const { POST } = await import("@/app/api/fleet/[id]/documents/route");
    const base = resolve;
    resolve = (q) => (q.table === "equipment_documents" ? { data: { id: "d1" }, error: null } : base(q));
    const res = await POST(req("POST", { fileBase64: JPEG, fileName: "rego paper.jpg" }), ctx({ id: MACHINE }));
    expect(res.status).toBe(200);
    expect(uploads[0]).toMatch(new RegExp(`^${MACHINE}/\\d+_rego_paper\\.jpg$`));
  });
});

describe("lib/fleet-office rules", () => {
  it("validates a service like the web form", () => {
    expect(parseServiceRecordBody({ service_type: "scheduled" })).toEqual({ ok: false, error: "Enter the service date." });
    expect(parseServiceRecordBody({ service_date: "2026-11-10", service_type: "scheduled", next_due_date: "2026-11-01" }).ok).toBe(false);
    expect(parseServiceRecordBody({ service_date: "2026-11-10", service_type: "scheduled", odometer_km: "100", next_due_km: "50" }).ok).toBe(false);
    expect(parseServiceRecordBody({ service_date: "2026-11-10", service_type: "scheduled", expense: "new", amount: "" }).ok).toBe(false);
    expect(parseServiceRecordBody({ service_date: "2026-11-10", service_type: "scheduled", invoice: { fileBase64: JPEG } }).ok).toBe(false);
    const ok = parseServiceRecordBody({ service_date: "2026-11-10", service_type: "repair", expense: EXPENSE });
    expect(ok.ok && ok.value.expense).toEqual({ kind: "existing", id: EXPENSE });
  });

  it("a new cost takes the service type's expense category and the work done", () => {
    const p = parseServiceRecordBody({ service_date: "2026-11-10", service_type: "tyres", expense: "new", amount: 900 });
    expect(p.ok && serviceExpenseRow(MACHINE, p.value, USER, null)).toMatchObject({ category: "tyres", description: "Tyres", amount: 900, gst_amount: 0 });
  });

  it("plans a hire setup save: duplicates refused, invalid units refused, floats keep only float fields", () => {
    expect(planHireOptionsSave(MACHINE, [], { options: [{ hire_type: "wet", hire_unit: "hour" }, { hire_type: "wet", hire_unit: "hour" }] }).ok).toBe(false);
    expect(planHireOptionsSave(MACHINE, [], { options: [{ hire_type: "wet", hire_unit: "day" }] }).ok).toBe(false);
    expect(planHireOptionsSave(MACHINE, [], { options: [{ hire_type: "dry", hire_unit: "day", rate: "-1" }] }).ok).toBe(false);
    const p = planHireOptionsSave(MACHINE, [], { options: [{ hire_type: "float", hire_unit: "move", rate: 99, float_base: 470, float_km_included: 30, float_per_km: 5, whole_days_only: true }] });
    expect(p.ok && p.value.upserts[0]).toMatchObject({ rate: 0, float_base: 470, whole_days_only: false, is_active: true, fuel_included: true });
  });

  it("sniffs uploads by their bytes", () => {
    expect(sniffFleetUpload(Buffer.from("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffFleetUpload(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffFleetUpload(Buffer.from("<html>"))).toBeNull();
    expect(parseAttachmentPatch({}).ok).toBe(false);
  });
});
