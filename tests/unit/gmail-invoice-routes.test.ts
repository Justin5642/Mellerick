import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Supplier invoices from Gmail (0124, drafted) — the routes:
//   /api/gmail/poll-invoices   GET = cron secret, POST = admin "Check now";
//                              a refused caller never reaches the import.
//   /api/gmail/invoices/[id]   POST assign / dismiss / reopen, office/admin,
//                              as the CALLER; never overwrites a PO's invoice.
//   /api/xero/push-vendor-order refuses an invoice still "from email — check".

const requireAdmin = vi.fn();
const requireCronSecret = vi.fn();
const requireOfficeOrAdmin = vi.fn();
vi.mock("@/lib/api/guards", () => ({
  requireAdmin: (...a: unknown[]) => requireAdmin(...a),
  requireCronSecret: (...a: unknown[]) => requireCronSecret(...a),
  requireOfficeOrAdmin: (...a: unknown[]) => requireOfficeOrAdmin(...a),
}));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn(), reportFailure: vi.fn() }));
const adminConstructed = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (adminConstructed(), {}) }));
const importGmailInvoices = vi.fn();
const fileOnOrder = vi.fn();
vi.mock("@/lib/gmail-invoices", async (orig) => ({
  ...(await orig<typeof import("@/lib/gmail-invoices")>()),
  importGmailInvoices: (...a: unknown[]) => importGmailInvoices(...a),
  connectedGmail: async () => null,
  defaultReader: () => null,
  fileOnOrder: (...a: unknown[]) => fileOnOrder(...a),
}));
const getRefreshedXero = vi.fn();
vi.mock("@/lib/xero", () => ({ getRefreshedXero: (...a: unknown[]) => getRefreshedXero(...a), describeXeroError: () => "x" }));

type Result = { data?: unknown; error?: unknown };
const writes: { table: string; payload: unknown; filters: string[] }[] = [];
let resolve: (table: string, op: string, filters: string[]) => Result = () => ({ data: null, error: null });
const callerFrom = vi.fn((table: string) => {
  let op = "select";
  const filters: string[] = [];
  let entry: { table: string; payload: unknown; filters: string[] } | null = null;
  const p: Record<string, unknown> = {};
  for (const m of ["select", "order", "limit"]) p[m] = () => p;
  for (const m of ["eq", "is", "in", "ilike", "neq"]) p[m] = (c: string, v: unknown) => (filters.push(`${m}:${c}=${String(v)}`), p);
  p.update = (payload: unknown) => ((op = "update"), (entry = { table, payload, filters }), writes.push(entry), p);
  p.maybeSingle = async () => resolve(table, op, filters);
  p.single = async () => resolve(table, op, filters);
  p.then = (ok: (r: Result) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve(table, op, filters)).then(ok, bad);
  return p;
});
const download = vi.fn(async () => ({ data: new Blob([Buffer.from("%PDF-1.7 x")]), error: null }));
vi.mock("@/lib/api/caller-client", () => ({
  callerClient: async () => ({ from: callerFrom, storage: { from: () => ({ download }) } }),
}));

import { GET as cronPoll, POST as adminPoll } from "@/app/api/gmail/poll-invoices/route";
import { POST as act } from "@/app/api/gmail/invoices/[id]/route";
import { POST as pushVendorOrder } from "@/app/api/xero/push-vendor-order/route";
import { GmailTablesMissing } from "@/lib/gmail-invoices";

const ID = "11111111-1111-4111-8111-111111111111";
const office = { ok: true, userId: "u-office", role: "office" };
const refused = { ok: false, response: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) };
const req = (method: string, body?: unknown) =>
  new NextRequest("http://x/api", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const reviewRow = {
  id: ID,
  status: "needs_review",
  storage_path: "gmail/2026-11-27/x.pdf",
  file_name: "inv.pdf",
  mime_type: "application/pdf",
  doc_kind: "invoice",
  supplier_name: "Reece",
  invoice_number: "INV-77",
  invoice_date: "2026-11-20",
  amount_ex_gst: 200,
  gst_amount: 20,
  total: 220,
  po_refs: [],
  job_refs: [],
};
const openOrder = { id: "o1", po_number: "PO-1008", job_id: "j1", vendor_name: "Reece", status: "ordered", invoice_number: null, xero_bill_id: null };

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  resolve = () => ({ data: null, error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/api/gmail/poll-invoices", () => {
  it("refuses a cron call without the secret and a non-admin POST before any service-role client", async () => {
    requireCronSecret.mockReturnValue(refused);
    requireAdmin.mockResolvedValue(refused);
    expect((await cronPoll(req("GET"))).status).toBe(403);
    expect((await adminPoll(req("POST"))).status).toBe(403);
    expect(adminConstructed).not.toHaveBeenCalled();
    expect(importGmailInvoices).not.toHaveBeenCalled();
  });

  it("runs the import and answers its result", async () => {
    requireCronSecret.mockReturnValue({ ok: true });
    importGmailInvoices.mockResolvedValue({ messages: 1, files: 1, matched: 1, needsReview: 0, more: false });
    const res = await cronPoll(req("GET"));
    expect(await res.json()).toMatchObject({ matched: 1 });
  });

  it("before 0124 (drafted) is applied: skipped, not an error", async () => {
    requireAdmin.mockResolvedValue({ ok: true, userId: "a", role: "admin" });
    importGmailInvoices.mockRejectedValue(new GmailTablesMissing());
    const res = await adminPoll(req("POST"));
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe(true);
  });

  it("an unexpected failure is a fixed sentence", async () => {
    requireCronSecret.mockReturnValue({ ok: true });
    importGmailInvoices.mockRejectedValue(new Error("secret token abc in message"));
    const res = await cronPoll(req("GET"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("abc");
  });
});

describe("/api/gmail/invoices/[id]", () => {
  it("is office/admin only", async () => {
    requireOfficeOrAdmin.mockResolvedValue(refused);
    expect((await act(req("POST", { action: "dismiss" }), ctx(ID))).status).toBe(403);
    expect(callerFrom).not.toHaveBeenCalled();
  });

  it("dismisses only from the review queue", async () => {
    requireOfficeOrAdmin.mockResolvedValue(office);
    resolve = (t, op) => (op === "update" ? { data: [{ id: ID }], error: null } : { data: reviewRow, error: null });
    const res = await act(req("POST", { action: "dismiss" }), ctx(ID));
    expect(res.status).toBe(200);
    expect(writes[0]).toMatchObject({ table: "gmail_supplier_invoices", payload: { status: "dismissed", handled_by: "u-office" } });
    expect(writes[0].filters).toContain("eq:status=needs_review");
  });

  it("assigns to a typed PO, flagged for checking, through the shared filing step", async () => {
    requireOfficeOrAdmin.mockResolvedValue(office);
    resolve = (t, op) => {
      if (t === "vendor_orders") return { data: openOrder, error: null };
      if (op === "update") return { data: [{ id: ID }], error: null };
      return { data: reviewRow, error: null };
    };
    fileOnOrder.mockResolvedValue({ ok: true, path: "j1/expense-receipt-PO-1008-1_inv.pdf" });
    const res = await act(req("POST", { action: "assign", poNumber: "1008" }), ctx(ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ poNumber: "PO-1008", jobId: "j1" });
    expect(fileOnOrder).toHaveBeenCalledTimes(1);
    expect(fileOnOrder.mock.calls[0][1]).toMatchObject({ id: "o1" });
    expect(fileOnOrder.mock.calls[0][2]).toMatchObject({ invoice_number: "INV-77", amount_ex_gst: 200 });
    expect(writes[0].payload).toMatchObject({ status: "matched", vendor_order_id: "o1" });
  });

  it("refuses a PO that already has an invoice — nothing filed", async () => {
    requireOfficeOrAdmin.mockResolvedValue(office);
    resolve = (t) => (t === "vendor_orders" ? { data: { ...openOrder, invoice_number: "TYPED" }, error: null } : { data: reviewRow, error: null });
    const res = await act(req("POST", { action: "assign", poNumber: "PO-1008" }), ctx(ID));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("PO-1008 already has invoice TYPED.");
    expect(fileOnOrder).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("puts the row back when filing fails", async () => {
    requireOfficeOrAdmin.mockResolvedValue(office);
    resolve = (t, op) => {
      if (t === "vendor_orders") return { data: openOrder, error: null };
      if (op === "update") return { data: [{ id: ID }], error: null };
      return { data: reviewRow, error: null };
    };
    fileOnOrder.mockResolvedValue({ ok: false, reason: "PO-1008 got an invoice in the meantime — check this one isn't a copy." });
    const res = await act(req("POST", { action: "assign", poNumber: "1008" }), ctx(ID));
    expect(res.status).toBe(409);
    expect(writes.at(-1)?.payload).toMatchObject({ status: "needs_review", vendor_order_id: null });
  });

  it("refuses a bad id, action or PO number", async () => {
    requireOfficeOrAdmin.mockResolvedValue(office);
    expect((await act(req("POST", { action: "dismiss" }), ctx("nope"))).status).toBe(400);
    expect((await act(req("POST", { action: "delete" }), ctx(ID))).status).toBe(400);
    resolve = () => ({ data: reviewRow, error: null });
    expect((await act(req("POST", { action: "assign", poNumber: "hello" }), ctx(ID))).status).toBe(400);
  });
});

describe("/api/xero/push-vendor-order", () => {
  it("won't make a bill from an invoice still waiting to be checked", async () => {
    requireOfficeOrAdmin.mockResolvedValue(office);
    resolve = (t, _op, filters) =>
      filters.length && t === "vendor_orders" && callerFrom.mock.calls.length > 1
        ? { data: { invoice_needs_check: true }, error: null }
        : { data: { id: "o1", po_number: "PO-1008", amount: 200, invoice_number: "INV-77", xero_bill_id: null, jobs: null, suppliers: null }, error: null };
    const res = await pushVendorOrder(req("POST", { orderId: "o1" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/read from an email/);
    expect(getRefreshedXero).not.toHaveBeenCalled();
  });
});
