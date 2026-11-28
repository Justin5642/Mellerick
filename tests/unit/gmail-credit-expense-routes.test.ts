import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Emailed supplier invoices (28 Nov 2026): the two one-click actions on
// POST /api/gmail/invoices/[id]:
//   { action: "credit" }  — a credit note under its PO (vendor_order_credits, 0125);
//   { action: "expense" } — a job-number-only bill as a job_expenses row.
// Office/admin only, every read and write as the CALLER (never the service
// role), idempotent, and refused when the order or job can't take it.

const requireOfficeOrAdmin = vi.fn();
vi.mock("@/lib/api/guards", () => ({
  requireOfficeOrAdmin: (...a: unknown[]) => requireOfficeOrAdmin(...a),
  requireAdmin: vi.fn(),
  requireCronSecret: vi.fn(),
}));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn(), reportFailure: vi.fn() }));
const adminConstructed = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (adminConstructed(), {}) }));

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let missing: string[] = [];
let failInsert: Record<string, { code: string }> = {};
let storage: Record<string, Map<string, Buffer>> = {};

function from(table: string) {
  let op: "select" | "insert" | "update" = "select";
  let payload: Row | null = null;
  let returning = false;
  const filters: ((r: Row) => boolean)[] = [];
  const run = () => {
    if (missing.includes(table)) return { data: null, error: { code: "42P01", message: "missing" } };
    const rows = (tables[table] ??= []);
    if (op === "insert") {
      if (failInsert[table]) return { data: null, error: failInsert[table] };
      if (rows.some((r) => r.id === payload!.id)) return { data: null, error: { code: "23505", message: "dup" } };
      rows.push({ ...payload });
      return { data: null, error: null };
    }
    const hit = rows.filter((r) => filters.every((f) => f(r)));
    if (op === "update") {
      for (const r of hit) Object.assign(r, payload);
      return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
    }
    return { data: hit, error: null };
  };
  const b: Record<string, unknown> = {
    select: () => ((returning = op !== "select"), b),
    insert: (p: Row) => ((op = "insert"), (payload = p), b),
    update: (p: Row) => ((op = "update"), (payload = p), b),
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    ilike: (c: string, v: string) => (filters.push((r) => String(r[c] ?? "").toLowerCase() === v.toLowerCase()), b),
    in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
    order: () => b,
    maybeSingle: async () => {
      const r = run();
      return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
    },
    then: (ok: (r: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  return b;
}
const caller = {
  from,
  storage: {
    from: (bucket: string) => ({
      download: async (path: string) =>
        bucket === "supplier-invoices" && path ? { data: new Blob([Buffer.from("%PDF-1.7 x")]), error: null } : { data: null, error: { message: "no" } },
      upload: async (path: string, file: Buffer) => ((storage[bucket] ??= new Map()).set(path, file), { data: { path }, error: null }),
      remove: async (paths: string[]) => (paths.forEach((p) => storage[bucket]?.delete(p)), { data: null, error: null }),
    }),
  },
};
const callerClient = vi.fn(async () => caller);
vi.mock("@/lib/api/caller-client", () => ({ callerClient: (...a: unknown[]) => callerClient(...(a as [])) }));

import { POST as act } from "@/app/api/gmail/invoices/[id]/route";

const ID = "22222222-2222-4222-8222-222222222222";
const office = { ok: true, userId: "u-office", role: "office" };
const refused = { ok: false, response: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) };
const req = (body: unknown) =>
  new NextRequest("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = { params: Promise.resolve({ id: ID }) };

const creditRow = (over: Row = {}): Row => ({
  id: ID,
  status: "needs_review",
  doc_kind: "credit_note",
  storage_path: "gmail/2026-11-28/x.pdf",
  file_name: "credit.pdf",
  mime_type: "application/pdf",
  supplier_name: "Reece",
  invoice_number: "CR-9",
  invoice_date: "2026-11-20",
  amount_ex_gst: 50,
  gst_amount: 5,
  total: 55,
  po_refs: ["PO-1008"],
  job_refs: [],
  vendor_order_id: "o1",
  job_id: "j1",
  ...over,
});
const invoicedOrder = (over: Row = {}): Row => ({
  id: "o1", po_number: "PO-1008", job_id: "j1", vendor_name: "Reece", status: "received",
  invoice_number: "INV-1", xero_bill_id: null, amount: 200, ...over,
});
const expenseRow = (over: Row = {}): Row => creditRow({ doc_kind: "invoice", invoice_number: "INV-55", amount_ex_gst: 300, gst_amount: 30, vendor_order_id: null, job_id: "job-a", ...over });
const openJob = (over: Row = {}): Row => ({ id: "job-a", job_number: 2542, status: "in_progress", actual_end: null, updated_at: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  tables = {};
  missing = [];
  failInsert = {};
  storage = {};
  requireOfficeOrAdmin.mockResolvedValue(office);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("auth", () => {
  it("refuses anyone but office/admin before any read", async () => {
    requireOfficeOrAdmin.mockResolvedValue(refused);
    for (const action of ["credit", "expense"]) {
      expect((await act(req({ action }), ctx)).status).toBe(403);
    }
    expect(callerClient).not.toHaveBeenCalled();
    expect(adminConstructed).not.toHaveBeenCalled();
  });
});

describe("Apply credit to PO", () => {
  it("adds the credit under the PO as the caller, file on the job, PO invoice untouched", async () => {
    tables = { gmail_supplier_invoices: [creditRow()], vendor_orders: [invoicedOrder()], vendor_order_credits: [] };
    const res = await act(req({ action: "credit" }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, poNumber: "PO-1008" });
    expect(callerClient).toHaveBeenCalled();
    expect(adminConstructed).not.toHaveBeenCalled();
    const c = tables.vendor_order_credits[0];
    expect(c).toMatchObject({ id: ID, gmail_invoice_id: ID, vendor_order_id: "o1", credit_number: "CR-9", amount_ex_gst: 50, gst_amount: 5 });
    expect(String(c.file_path)).toMatch(/^j1\/expense-receipt-PO-1008-credit-\d+_credit\.pdf$/);
    expect(storage["job-documents"].has(String(c.file_path))).toBe(true);
    expect(tables.vendor_orders[0]).toMatchObject({ invoice_number: "INV-1", amount: 200 });
    expect(tables.gmail_supplier_invoices[0]).toMatchObject({ status: "matched", handled_by: "u-office", job_document_path: c.file_path });
  });

  it("is idempotent: a second click after it went through adds nothing", async () => {
    tables = { gmail_supplier_invoices: [creditRow()], vendor_orders: [invoicedOrder()], vendor_order_credits: [] };
    await act(req({ action: "credit" }), ctx);
    const again = await act(req({ action: "credit" }), ctx);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ already: true });
    expect(tables.vendor_order_credits).toHaveLength(1);
  });

  it("refuses a credit larger than what's left of the order's invoice", async () => {
    tables = {
      gmail_supplier_invoices: [creditRow({ amount_ex_gst: 120 })],
      vendor_orders: [invoicedOrder()],
      vendor_order_credits: [{ id: "c0", vendor_order_id: "o1", credit_number: "CR-1", amount_ex_gst: 100 }],
    };
    const res = await act(req({ action: "credit" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/more than what's left of PO-1008's invoice \(\$100\.00/);
    expect(tables.vendor_order_credits).toHaveLength(1);
    expect(tables.gmail_supplier_invoices[0].status).toBe("needs_review");
  });

  it.each([
    ["a cancelled order", { status: "cancelled" }, /cancelled/],
    ["an order with no invoice", { invoice_number: null }, /no invoice yet/],
  ])("refuses %s", async (_n, over, re) => {
    tables = { gmail_supplier_invoices: [creditRow()], vendor_orders: [invoicedOrder(over)], vendor_order_credits: [] };
    const res = await act(req({ action: "credit" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(re);
    expect(tables.vendor_order_credits).toHaveLength(0);
  });

  it("refuses a missing order", async () => {
    tables = { gmail_supplier_invoices: [creditRow()], vendor_orders: [], vendor_order_credits: [] };
    expect((await act(req({ action: "credit" }), ctx)).status).toBe(404);
  });

  it("refuses something that isn't a credit note", async () => {
    tables = { gmail_supplier_invoices: [creditRow({ doc_kind: "invoice" })], vendor_orders: [invoicedOrder()] };
    expect((await act(req({ action: "credit" }), ctx)).status).toBe(400);
  });

  it("before 0125: says credits aren't switched on and writes nothing", async () => {
    tables = { gmail_supplier_invoices: [creditRow()], vendor_orders: [invoicedOrder()] };
    missing = ["vendor_order_credits"];
    const res = await act(req({ action: "credit" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/aren't switched on yet/);
    expect(tables.gmail_supplier_invoices[0].status).toBe("needs_review");
  });

  it("a refused insert puts the row back and removes the copied file", async () => {
    tables = { gmail_supplier_invoices: [creditRow()], vendor_orders: [invoicedOrder()], vendor_order_credits: [] };
    failInsert = { vendor_order_credits: { code: "23514" } };
    const res = await act(req({ action: "credit" }), ctx);
    expect(res.status).toBe(409);
    expect(tables.gmail_supplier_invoices[0].status).toBe("needs_review");
    expect(storage["job-documents"].size).toBe(0);
  });
});

describe("Add as job expense", () => {
  it("adds a job_expenses row as the caller with the file on the job", async () => {
    tables = { gmail_supplier_invoices: [expenseRow()], jobs: [openJob()], job_expenses: [] };
    const res = await act(req({ action: "expense" }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ jobNumber: 2542 });
    const e = tables.job_expenses[0];
    expect(e).toMatchObject({ id: ID, job_id: "job-a", supplier_name: "Reece", invoice_number: "INV-55", amount: 300, gst_amount: 30, entered_by: "u-office", category: "materials" });
    expect(String(e.receipt_storage_path)).toMatch(/^job-a\/expense-receipt-\d+_credit\.pdf$/);
    expect(tables.gmail_supplier_invoices[0]).toMatchObject({ status: "matched", job_id: "job-a" });
    expect(adminConstructed).not.toHaveBeenCalled();
  });

  it("is idempotent: a second click adds nothing", async () => {
    tables = { gmail_supplier_invoices: [expenseRow()], jobs: [openJob()], job_expenses: [] };
    await act(req({ action: "expense" }), ctx);
    const again = await act(req({ action: "expense" }), ctx);
    expect(await again.json()).toMatchObject({ already: true });
    expect(tables.job_expenses).toHaveLength(1);
  });

  it("refuses a cancelled job and a missing job", async () => {
    tables = { gmail_supplier_invoices: [expenseRow()], jobs: [openJob({ status: "cancelled" })], job_expenses: [] };
    expect((await act(req({ action: "expense" }), ctx)).status).toBe(409);
    tables = { gmail_supplier_invoices: [expenseRow()], jobs: [], job_expenses: [] };
    expect((await act(req({ action: "expense" }), ctx)).status).toBe(404);
    expect(tables.job_expenses).toHaveLength(0);
  });

  it("refuses the same invoice number already an expense on the job", async () => {
    tables = { gmail_supplier_invoices: [expenseRow()], jobs: [openJob()], job_expenses: [{ id: "e0", job_id: "job-a", invoice_number: "inv-55" }] };
    const res = await act(req({ action: "expense" }), ctx);
    expect(res.status).toBe(409);
    expect(tables.job_expenses).toHaveLength(1);
  });

  it("refuses a row with a PO (that's assign's job) or no job", async () => {
    tables = { gmail_supplier_invoices: [expenseRow({ vendor_order_id: "o1" })], jobs: [openJob()] };
    expect((await act(req({ action: "expense" }), ctx)).status).toBe(400);
    tables = { gmail_supplier_invoices: [expenseRow({ job_id: null })], jobs: [openJob()] };
    expect((await act(req({ action: "expense" }), ctx)).status).toBe(400);
  });
});
