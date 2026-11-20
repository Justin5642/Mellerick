import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { copyTitle, copiedJobRow, defaultCopyTitle, templatePo } from "@/lib/job-copy";

// POST /api/jobs/[id]/copy — "Copy job" (20 Nov 2026). Office/admin, run as
// the caller (never the service role), fixed sentences out, nothing but the
// template copied: no money, bookings, time or files.

const guard = vi.fn();
vi.mock("@/lib/api/guards", () => ({ requireOfficeOrAdmin: (...a: unknown[]) => guard(...a) }));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));
const adminConstructed = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { adminConstructed(); return {}; } }));

interface Op { table: string; action: string; payload?: unknown; filters: unknown[][] }
let ops: Op[] = [];
let tables: Record<string, unknown[]> = {};
let failInsert: Record<string, { code?: string; message: string }> = {};

function client() {
  return {
    from(table: string) {
      const op: Op = { table, action: "select", filters: [] };
      ops.push(op);
      const answer = () => {
        if (op.action === "insert") {
          const err = failInsert[table];
          if (err) return { data: null, error: err };
          if (table === "jobs") return { data: { id: (op.payload as { id?: string }).id ?? "new-job", job_number: 900 }, error: null };
          return { data: { id: `new-${table}` }, error: null };
        }
        if (op.action !== "select") return { data: null, error: null };
        let rows = tables[table] ?? [];
        for (const [m, col, v] of op.filters) if (m === "eq") rows = rows.filter((r) => (r as Record<string, unknown>)[col as string] === v);
        return { data: rows, error: null };
      };
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (c: string, v: unknown) => (op.filters.push(["eq", c, v]), chain);
      chain.order = () => chain;
      chain.insert = (p: unknown) => ((op.action = "insert"), (op.payload = p), chain);
      chain.delete = () => ((op.action = "delete"), chain);
      chain.single = async () => {
        const a = answer();
        return { ...a, data: Array.isArray(a.data) ? a.data[0] ?? null : a.data };
      };
      chain.maybeSingle = chain.single;
      chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(answer()).then(res, rej);
      return chain;
    },
  };
}
vi.mock("@/lib/api/caller-client", () => ({ callerClient: async () => client() }));

import { POST } from "@/app/api/jobs/[id]/copy/route";

const SRC = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const call = (body: unknown = {}) =>
  POST(new NextRequest(`http://localhost/api/jobs/${SRC}/copy`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: SRC }) });

beforeEach(() => {
  vi.clearAllMocks();
  guard.mockResolvedValue({ ok: true, userId: "office-1", role: "office" });
  ops = [];
  failInsert = {};
  tables = {
    jobs: [{ id: SRC, customer_id: "c1", site_id: "s1", title: "Lot 7 drainage", job_type: "project", priority: "high", description: "Sewer and storm" }],
    purchase_orders: [
      {
        id: "po1",
        job_id: SRC,
        po_cost_centers: [
          { name: "Transport", cost_centre_id: "cc-t", allocated_hours: 4, code: null, sort_order: 1 },
          { name: "Below Ground Drainage", cost_centre_id: "cc-d", allocated_hours: "30", code: "BGD", sort_order: 0 },
        ],
      },
    ],
  };
});

describe("job copy rules", () => {
  it("titles the copy 'Copy of …' unless one was typed", () => {
    expect(defaultCopyTitle(" Lot 7 ")).toBe("Copy of Lot 7");
    expect(copyTitle(undefined, "Lot 7")).toBe("Copy of Lot 7");
    expect(copyTitle("  Lot 8 drainage ", "Lot 7")).toBe("Lot 8 drainage");
    expect(copyTitle("x".repeat(201), "Lot 7")).toBeNull();
  });

  it("makes a fresh pending job — status, schedule and money are never copied", () => {
    const row = copiedJobRow({ customer_id: "c", site_id: null, title: "t", job_type: null, priority: null, description: null }, "Copy of t", "u");
    expect(row).toEqual({ customer_id: "c", site_id: null, title: "Copy of t", job_type: null, priority: "normal", description: null, status: "pending", created_by: "u" });
  });

  it("copies cost-centre lines with hours under <n>-1 at $0", () => {
    const plan = templatePo(900, [
      { name: "Drainage", cost_centre_id: "a", allocated_hours: 30 },
      { name: " ", cost_centre_id: null, allocated_hours: 5 },
      { name: "Transport", cost_centre_id: null, allocated_hours: -2 },
    ])!;
    expect(plan.po).toEqual({ po_number: "900-1", total_value: 0, total_hours: 30 });
    expect(plan.lines.map((l) => [l.name, l.allocated_hours, l.allocated_amount, l.sort_order])).toEqual([
      ["Drainage", 30, 0, 0],
      ["Transport", 0, 0, 1],
    ]);
    expect(templatePo(900, [])).toBeNull();
  });
});

describe("POST /api/jobs/[id]/copy", () => {
  it("refuses whoever the office guard refuses, before touching the database", async () => {
    guard.mockResolvedValue({ ok: false, response: new Response("{}", { status: 403 }) });
    expect((await call()).status).toBe(403);
    expect(ops).toEqual([]);
  });

  it("copies the job and its cost centres, as the caller, nothing else", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "new-job", jobNumber: 900, poNumber: "900-1" });
    const inserts = ops.filter((o) => o.action === "insert");
    expect(inserts.map((o) => o.table)).toEqual(["jobs", "purchase_orders", "po_cost_centers"]);
    expect(inserts[0].payload).toMatchObject({ customer_id: "c1", site_id: "s1", title: "Copy of Lot 7 drainage", job_type: "project", priority: "high", status: "pending", created_by: "office-1" });
    expect(inserts[1].payload).toEqual({ job_id: "new-job", po_number: "900-1", total_value: 0, total_hours: 34 });
    expect((inserts[2].payload as { name: string; allocated_amount: number }[]).map((l) => [l.name, l.allocated_amount])).toEqual([
      ["Below Ground Drainage", 0],
      ["Transport", 0],
    ]);
    expect(adminConstructed).not.toHaveBeenCalled();
  });

  it("finds the job a retry already made", async () => {
    tables.jobs.push({ id: NEW, job_number: 901 });
    const res = await call({ newJobId: NEW });
    expect(await res.json()).toEqual({ id: NEW, jobNumber: 901 });
    expect(ops.some((o) => o.action === "insert")).toBe(false);
  });

  it("keeps the new job and warns when its cost centres can't be saved", async () => {
    failInsert.po_cost_centers = { code: "42501", message: "denied po_cost_centers" };
    const res = await call({ title: "Lot 8" });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ id: "new-job", poNumber: null });
    expect(json.warning).toMatch(/PO tab/);
    expect(JSON.stringify(json)).not.toMatch(/denied/);
    expect(ops.some((o) => o.table === "purchase_orders" && o.action === "delete")).toBe(true);
  });

  it("answers fixed sentences", async () => {
    failInsert.jobs = { code: "XX000", message: "secret db text" };
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/secret/);
    expect((await call({ newJobId: "nope" })).status).toBe(400);
    tables.jobs = [];
    expect((await call()).status).toBe(404);
  });
});
