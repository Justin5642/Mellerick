import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Supplier POs raised from the phone. The route reaches office-only,
// money-bearing tables with the service-role client on a technician's behalf,
// so the two things that must never break are: nobody unauthenticated gets in,
// and no dollar figure ever comes back.

const requireUser = vi.fn();
const adminConstructed = vi.fn();
const sendEmail = vi.fn();
const selects: { table: string; cols: string }[] = [];
const inserts: { table: string; rows: unknown }[] = [];
let tableData: Record<string, { list?: unknown[]; one?: unknown }> = {};

vi.mock("@/lib/api/guards", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/api/rate-limit", () => ({
  consumeRateLimit: vi.fn(async () => true),
  rateLimitedResponse: vi.fn(),
  SUPPLIER_ORDER_LIMIT: {},
}));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/resend", () => ({
  getResend: () => ({ emails: { send: (...a: unknown[]) => sendEmail(...a) } }),
  getFromAddress: () => "Mellerick <po@example.com>",
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    adminConstructed();
    return {
      from: vi.fn((table: string) => {
        const chain: Record<string, unknown> = {};
        for (const m of ["eq", "is", "neq", "not", "order", "limit", "update", "delete"]) chain[m] = vi.fn(() => chain);
        chain.select = vi.fn((cols: string) => {
          selects.push({ table, cols });
          return chain;
        });
        chain.insert = vi.fn((rows: unknown) => {
          inserts.push({ table, rows });
          return chain;
        });
        chain.maybeSingle = vi.fn(async () => ({ data: tableData[table]?.one ?? null, error: null }));
        chain.single = vi.fn(async () => ({ data: { po_number: "PO-1001" }, error: null }));
        chain.then = (r: (v: unknown) => unknown) => r({ data: tableData[table]?.list ?? [], error: null });
        return chain;
      }),
    };
  }),
}));

import { GET, POST } from "@/app/api/jobs/[id]/supplier-orders/route";
import { parseSupplierOrder, supplierOrderEmail } from "@/lib/supplier-orders";

const JOB = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";
const params = { params: Promise.resolve({ id: JOB }) };
const DENIED = { ok: false as const, response: new Response("{}", { status: 401 }) };
const tech = { ok: true as const, userId: "tech-1", role: null };
const body = {
  id: ORDER,
  costCenterId: null,
  supplierName: "Reece Epping",
  supplierEmail: "orders@reece.example",
  items: [{ description: "20mm copper elbow", quantity: 4 }],
};
const post = (b: unknown) =>
  POST(new NextRequest(`http://localhost/api/jobs/${JOB}/supplier-orders`, { method: "POST", body: JSON.stringify(b) }), params);

beforeEach(() => {
  vi.clearAllMocks();
  selects.length = 0;
  inserts.length = 0;
  tableData = { jobs: { one: { id: JOB, job_number: 4321, scheduled_cost_center_id: null, sites: null } } };
  sendEmail.mockResolvedValue({ error: null });
});

describe("parseSupplierOrder", () => {
  it("accepts a complete order and drops blank rows", () => {
    const r = parseSupplierOrder({ ...body, items: [...body.items, { description: "  ", quantity: 1 }] });
    expect(r.ok && r.order.items).toEqual([{ description: "20mm copper elbow", quantity: 4 }]);
  });

  it("allows no email (counter / phone order)", () => {
    const r = parseSupplierOrder({ ...body, supplierEmail: "" });
    expect(r.ok && r.order.supplierEmail).toBeNull();
  });

  it.each([
    [{ ...body, id: "not-a-uuid" }, /update the app/],
    [{ ...body, supplierName: " " }, /supplier's name/],
    [{ ...body, supplierEmail: "nope" }, /email/],
    [{ ...body, items: [] }, /at least one item/],
    [{ ...body, items: [{ description: "Tee", quantity: 0 }] }, /"Tee"/],
    [{ ...body, costCenterId: "x" }, /cost centre/],
    [{ ...body, requiredBy: "next week" }, /date/],
  ])("refuses %#", (input, message) => {
    const r = parseSupplierOrder(input);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(message);
  });
});

describe("supplierOrderEmail", () => {
  it("escapes everything a tech typed", () => {
    const { html } = supplierOrderEmail({
      poNumber: "PO-1001",
      jobNumber: 4321,
      supplierName: "<b>Reece</b>",
      raisedBy: { name: "Sam", phone: null },
      deliveryAddress: "1 <script>x</script> St",
      requiredBy: "2026-11-02",
      notes: "gate <img src=x>",
      items: [{ description: "<i>elbow</i>", quantity: 4 }],
      business: { name: "Mellerick", phone: "1", email: "a@b.c", address: "x", abn: "1" },
    });
    expect(html).not.toMatch(/<script>|<img|<b>Reece|<i>elbow/);
    expect(html).toContain("PO-1001");
    expect(html).toContain("02/11/2026");
  });
});

describe("/api/jobs/[id]/supplier-orders", () => {
  it("refuses an unauthenticated caller before touching the database", async () => {
    requireUser.mockResolvedValue(DENIED);
    expect((await GET(new NextRequest("http://localhost/x"), params)).status).toBe(401);
    expect((await post(body)).status).toBe(401);
    expect(adminConstructed).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("never selects or returns a dollar figure", async () => {
    requireUser.mockResolvedValue(tech);
    // Even if the database handed one back, it must not reach the phone.
    tableData.vendor_orders = {
      list: [{ id: ORDER, po_number: "PO-1001", vendor_name: "Reece", amount: 987.65, gst_amount: 98.76, vendor_order_items: [] }],
    };
    const res = await GET(new NextRequest("http://localhost/x"), params);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toMatch(/987\.65|98\.76|"amount"|gst/);
    for (const s of selects.filter((x) => x.table === "vendor_orders")) {
      expect(s.cols).not.toMatch(/amount|\*/);
    }
  });

  it("raises the order as the caller, with no price, and emails the supplier with the office copied", async () => {
    requireUser.mockResolvedValue(tech);
    const res = await post(body);
    expect(await res.json()).toMatchObject({ poNumber: "PO-1001", emailed: true });
    const order = inserts.find((i) => i.table === "vendor_orders")!.rows as Record<string, unknown>;
    expect(order).toMatchObject({ id: ORDER, job_id: JOB, entered_by: "tech-1", cost_center_id: null });
    expect(order).not.toHaveProperty("amount");
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "orders@reece.example", cc: expect.any(String) }));
  });

  it("a retried request returns the PO already raised and does not email again", async () => {
    requireUser.mockResolvedValue(tech);
    tableData.vendor_orders = {
      one: { job_id: JOB, po_number: "PO-1001", supplier_email: "orders@reece.example", emailed_at: "2026-10-28T00:00:00Z" },
    };
    const res = await post(body);
    expect(await res.json()).toMatchObject({ poNumber: "PO-1001", emailed: true });
    expect(inserts).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("keeps the PO and says so when the email fails", async () => {
    requireUser.mockResolvedValue(tech);
    sendEmail.mockResolvedValue({ error: { message: "domain not verified" } });
    const res = await post(body);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ poNumber: "PO-1001", emailed: false });
    expect(json.warning).toMatch(/PO-1001/);
    expect(json.warning).not.toMatch(/domain not verified/);
  });
});
