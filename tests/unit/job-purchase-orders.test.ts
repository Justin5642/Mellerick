import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  decodeUploadedFile,
  linesInUse,
  parseMoney,
  poSiteCoords,
  safeFileName,
  supplierInvoicePath,
  usageByLine,
} from "@/lib/job-purchase-orders";

// The phone's office PO tab and document uploads (Nov 2026) write through
// these routes. Pinned: the office/admin guard runs before any database
// client is made; every write runs as the CALLER (callerClient — never the
// service role); the web's PO rules hold on the server (a line with supplier
// orders can't be removed, whatever the phone sends); a supplier invoice file
// lands at the money-file path technicians can't open; a Xero bill's amount
// stays locked.

const guard = vi.fn();
const callerClient = vi.fn();
const adminClient = vi.fn();
vi.mock("@/lib/api/guards", () => ({ requireOfficeOrAdmin: (...a: unknown[]) => guard(...a) }));
vi.mock("@/lib/api/caller-client", () => ({ callerClient: (...a: unknown[]) => callerClient(...a) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: (...a: unknown[]) => adminClient(...a) }));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));

import { GET as posGET, POST as posPOST } from "@/app/api/jobs/[id]/purchase-orders/route";
import { PATCH as poPATCH, DELETE as poDELETE } from "@/app/api/jobs/[id]/purchase-orders/[poId]/route";
import { PATCH as orderPATCH, DELETE as orderDELETE } from "@/app/api/jobs/[id]/supplier-orders/[orderId]/route";
import { POST as invoicePOST } from "@/app/api/jobs/[id]/supplier-orders/[orderId]/invoice/route";
import { POST as docPOST } from "@/app/api/jobs/[id]/documents/route";
import { PATCH as docPATCH, DELETE as docDELETE } from "@/app/api/jobs/[id]/documents/[docId]/route";

const JOB = "11111111-1111-4111-8111-111111111111";
const PO = "22222222-2222-4222-8222-222222222222";
const LINE_A = "33333333-3333-4333-8333-333333333333";
const LINE_B = "44444444-4444-4444-8444-444444444444";
const ORDER = "55555555-5555-4555-8555-555555555555";
const CC_DRAIN = "66666666-6666-4666-8666-666666666666";
const CC_TRANSPORT = "77777777-7777-4777-8777-777777777777";

interface Op {
  table: string;
  action: "select" | "insert" | "update" | "delete";
  payload?: unknown;
  filters: [string, unknown[]][];
}

type Tables = Record<string, unknown[]>;

/** A Supabase client double: reads answer from `tables`, writes are recorded and succeed. */
function fakeClient(tables: Tables, opts: { failUpdate?: boolean } = {}) {
  const ops: Op[] = [];
  const uploads: { bucket: string; path: string; contentType?: string }[] = [];
  const removed: string[] = [];
  const from = (table: string) => {
    const op: Op = { table, action: "select", filters: [] };
    ops.push(op);
    const answer = (single: boolean) => {
      if (op.action !== "select" && !(op.action === "insert" && single)) {
        const failed = op.action === "update" && opts.failUpdate;
        return { data: null, error: failed ? { message: "denied" } : null, count: failed ? 0 : 1 };
      }
      if (op.action === "insert") return { data: { id: "new-row" }, error: null };
      let rows = tables[table] ?? [];
      for (const [m, args] of op.filters) {
        if (m === "eq") rows = rows.filter((r) => (r as Record<string, unknown>)[args[0] as string] === args[1] || !(args[0] as string in (r as object)));
      }
      return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
    };
    const chain: Record<string, unknown> = {};
    for (const m of ["eq", "in", "not", "order", "limit"]) chain[m] = (...args: unknown[]) => (op.filters.push([m, args]), chain);
    chain.select = () => chain;
    chain.insert = (payload: unknown) => ((op.action = "insert"), (op.payload = payload), chain);
    chain.update = (payload: unknown) => ((op.action = "update"), (op.payload = payload), chain);
    chain.delete = () => ((op.action = "delete"), chain);
    chain.maybeSingle = async () => answer(true);
    chain.single = async () => answer(true);
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(answer(false)).then(resolve, reject);
    return chain;
  };
  const storage = {
    from: (bucket: string) => ({
      upload: async (path: string, _bytes: unknown, o?: { contentType?: string }) => (uploads.push({ bucket, path, contentType: o?.contentType }), { error: null }),
      remove: async (paths: string[]) => (removed.push(...paths), { data: paths.map((name) => ({ name })), error: null }),
    }),
  };
  return { client: { from, storage }, ops, uploads, removed };
}

function baseTables(): Tables {
  return {
    jobs: [{ id: JOB, job_number: 4321, title: "Lot 7", customers: { name: "Acme Homes" }, sites: { name: null, address_line1: "7 Pony Promenade", suburb: "Mickleham", state: "VIC", postcode: "3064", site_lat: -37.5, site_lng: 144.9 } }],
    purchase_orders: [
      {
        id: PO,
        po_number: "4321-1",
        client_reference: "Acme Homes",
        site_address: "7 Pony Promenade, Mickleham VIC 3064",
        site_lat: -37.5,
        site_lng: 144.9,
        total_value: 10000,
        total_hours: 40,
        po_cost_centers: [
          { id: LINE_A, name: "Below Ground Drainage", cost_centre_id: CC_DRAIN, allocated_amount: 8000, allocated_hours: 30, sort_order: 0, completed_at: null },
          { id: LINE_B, name: "Transport", cost_centre_id: CC_TRANSPORT, allocated_amount: 2000, allocated_hours: 10, sort_order: 1, completed_at: null },
        ],
      },
    ],
    cost_centres: [
      { id: CC_DRAIN, name: "Below Ground Drainage" },
      { id: CC_TRANSPORT, name: "Transport" },
    ],
    vendor_orders: [
      { id: ORDER, cost_center_id: LINE_B, po_number: "PO-1001", vendor_name: "Northern Quarries", amount: 0, gst_amount: 0, status: "ordered", xero_bill_id: null, invoice_storage_path: null, vendor_order_items: [], profiles: null },
    ],
    time_entries: [],
    job_expenses: [],
    invoices: [],
    job_documents: [],
  };
}

// The routes each type their own params; one helper serves them all.
const ctx = (p: Record<string, string>) => ({ params: Promise.resolve({ id: JOB, ...p }) as Promise<never> });
const req = (method: string, body?: unknown) =>
  new NextRequest("https://app.test/api/x", {
    method,
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]).toString("base64");
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, 32)]).toString("base64");

beforeEach(() => {
  vi.clearAllMocks();
  guard.mockResolvedValue({ ok: true, userId: "office-user", role: "office" });
});

describe("guard first, as the caller", () => {
  const calls: [string, () => Promise<Response>][] = [
    ["GET purchase-orders", () => posGET(req("GET"), ctx({}))],
    ["POST purchase-orders", () => posPOST(req("POST", {}), ctx({}))],
    ["PATCH po", () => poPATCH(req("PATCH", {}), ctx({ poId: PO }))],
    ["DELETE po", () => poDELETE(req("DELETE"), ctx({ poId: PO }))],
    ["PATCH order", () => orderPATCH(req("PATCH", { amount: "1" }), ctx({ orderId: ORDER }))],
    ["DELETE order", () => orderDELETE(req("DELETE"), ctx({ orderId: ORDER }))],
    ["POST invoice", () => invoicePOST(req("POST", { invoiceNumber: "1", amount: "1" }), ctx({ orderId: ORDER }))],
    ["POST document", () => docPOST(req("POST", { file: JPEG }), ctx({}))],
    ["PATCH document", () => docPATCH(req("PATCH", { officeOnly: true }), ctx({ docId: ORDER }))],
    ["DELETE document", () => docDELETE(req("DELETE"), ctx({ docId: ORDER }))],
  ];
  it.each(calls)("%s refuses a technician before touching the database", async (_n, call) => {
    guard.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) });
    const res = await call();
    expect(res.status).toBe(403);
    expect(callerClient).not.toHaveBeenCalled();
    expect(adminClient).not.toHaveBeenCalled();
  });
});

describe("GET purchase-orders", () => {
  it("answers the tab with the next PO number, the client and the job site", async () => {
    const fake = fakeClient(baseTables());
    callerClient.mockResolvedValue(fake.client);
    const res = await posGET(req("GET"), ctx({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.defaults).toEqual({ poNumber: "4321-2", clientReference: "Acme Homes", siteAddress: "7 Pony Promenade, Mickleham VIC 3064" });
    expect(body.pos[0].lines.map((l: { id: string }) => l.id)).toEqual([LINE_A, LINE_B]);
    expect(body.inUse).toEqual({ [LINE_B]: "it has supplier orders against it." });
    expect(adminClient).not.toHaveBeenCalled();
  });
});

describe("POST purchase-orders (add)", () => {
  it("saves the PO and its lines; a blank value is the lines' total; the job site's pin is used", async () => {
    const tables = baseTables();
    const fake = fakeClient({ ...tables, purchase_orders: [] });
    callerClient.mockResolvedValue(fake.client);
    const id = "88888888-8888-4888-8888-888888888888";
    const res = await posPOST(
      req("POST", {
        id,
        poNumber: "4321-2",
        clientReference: "Acme Homes",
        siteAddress: "7 Pony Promenade, Mickleham VIC 3064",
        value: "",
        lines: [{ costCentreId: CC_TRANSPORT, stage: "", amount: "1500", hours: "6" }],
      }),
      ctx({})
    );
    expect(res.status).toBe(200);
    const po = fake.ops.find((o) => o.table === "purchase_orders" && o.action === "insert")!;
    expect(po.payload).toMatchObject({ id, job_id: JOB, po_number: "4321-2", total_value: 1500, total_hours: 6, site_lat: -37.5, site_lng: 144.9 });
    const lines = fake.ops.find((o) => o.table === "po_cost_centers" && o.action === "insert")!;
    expect(lines.payload).toEqual([{ cost_centre_id: CC_TRANSPORT, name: "Transport", allocated_amount: 1500, allocated_hours: 6, sort_order: 0, po_id: id }]);
  });

  it("refuses a PO with no value and no lines, with the web's sentence", async () => {
    callerClient.mockResolvedValue(fakeClient({ ...baseTables(), purchase_orders: [] }).client);
    const res = await posPOST(req("POST", { id: "88888888-8888-4888-8888-888888888888", poNumber: "4321-2", value: "", lines: [] }), ctx({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Enter the PO value (ex GST), or split it across cost centres.");
  });

  it("answers a retry with the same id as saved, adding nothing", async () => {
    const fake = fakeClient(baseTables());
    callerClient.mockResolvedValue(fake.client);
    const res = await posPOST(req("POST", { id: PO, poNumber: "4321-1", value: "10000", lines: [] }), ctx({}));
    expect(res.status).toBe(200);
    expect(fake.ops.some((o) => o.action === "insert")).toBe(false);
  });
});

describe("PATCH purchase-orders/[poId] (edit)", () => {
  const savedLines = [
    { id: LINE_A, costCentreId: CC_DRAIN, stage: "", amount: "8000.00", hours: "30" },
    { id: LINE_B, costCentreId: CC_TRANSPORT, stage: "", amount: "2000.00", hours: "10" },
  ];

  it("won't remove a line with supplier orders, whatever the phone sends — nothing is written", async () => {
    const fake = fakeClient(baseTables());
    callerClient.mockResolvedValue(fake.client);
    const res = await poPATCH(req("PATCH", { poNumber: "4321-1", value: "10000", lines: [savedLines[0]] }), ctx({ poId: PO }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Transport can't be removed: it has supplier orders against it. Set its amount to $0 instead.");
    expect(fake.ops.filter((o) => o.action !== "select")).toEqual([]);
  });

  it("updates lines in place, inserts new ones and saves the PO's value and hours", async () => {
    const fake = fakeClient(baseTables());
    callerClient.mockResolvedValue(fake.client);
    const res = await poPATCH(
      req("PATCH", {
        poNumber: "4321-1",
        clientReference: "Acme",
        siteAddress: "7 Pony Promenade, Mickleham VIC 3064",
        value: "12000",
        lines: [...savedLines, { costCentreId: CC_DRAIN, stage: "Sewer", amount: "2000", hours: "5" }],
      }),
      ctx({ poId: PO })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).warning).toBeUndefined();
    expect(fake.ops.filter((o) => o.table === "po_cost_centers" && o.action === "update")).toHaveLength(2);
    expect(fake.ops.find((o) => o.table === "po_cost_centers" && o.action === "insert")!.payload).toEqual([
      { cost_centre_id: CC_DRAIN, name: "Sewer", allocated_amount: 2000, allocated_hours: 5, sort_order: 2, po_id: PO },
    ]);
    expect(fake.ops.find((o) => o.table === "purchase_orders" && o.action === "update")!.payload).toMatchObject({
      total_value: 12000,
      total_hours: 45,
      client_reference: "Acme",
      site_lat: -37.5,
    });
  });
});

describe("supplier invoice", () => {
  it("stores the photo at the money-file path and the amount with 10% GST", async () => {
    const fake = fakeClient(baseTables());
    callerClient.mockResolvedValue(fake.client);
    const res = await invoicePOST(
      req("POST", { invoiceNumber: "INV-9", invoiceDate: "2026-11-18", amount: "250", file: JPEG, fileName: "invoice-INV-9" }),
      ctx({ orderId: ORDER })
    );
    expect(res.status).toBe(200);
    expect(fake.uploads).toHaveLength(1);
    expect(fake.uploads[0].bucket).toBe("job-documents");
    expect(fake.uploads[0].path).toMatch(new RegExp(`^${JOB}/expense-receipt-PO-1001-\\d+_invoice-INV-9\\.jpg$`));
    const update = fake.ops.find((o) => o.table === "vendor_orders" && o.action === "update")!;
    expect(update.payload).toMatchObject({ invoice_number: "INV-9", invoice_date: "2026-11-18", amount: 250, gst_amount: 25, status: "received", invoice_storage_path: fake.uploads[0].path });
  });

  it("keeps a Xero bill's amount locked", async () => {
    const tables = baseTables();
    tables.vendor_orders = [{ ...(tables.vendor_orders[0] as object), amount: 100, xero_bill_id: "bill-1" }];
    const fake = fakeClient(tables);
    callerClient.mockResolvedValue(fake.client);
    const res = await invoicePOST(req("POST", { invoiceNumber: "INV-9", amount: "250" }), ctx({ orderId: ORDER }));
    expect(res.status).toBe(409);
    const amount = await orderPATCH(req("PATCH", { amount: "250" }), ctx({ orderId: ORDER }));
    expect(amount.status).toBe(409);
    expect(fake.ops.some((o) => o.action === "update")).toBe(false);
  });

  it("removes the uploaded file again when the order can't be updated", async () => {
    const fake = fakeClient(baseTables(), { failUpdate: true });
    callerClient.mockResolvedValue(fake.client);
    const res = await invoicePOST(req("POST", { invoiceNumber: "INV-9", amount: "250", file: JPEG }), ctx({ orderId: ORDER }));
    expect(res.status).toBe(500);
    expect(fake.removed).toEqual([fake.uploads[0].path]);
  });
});

describe("job documents", () => {
  it("uploads as the caller and records the row, office only when asked", async () => {
    const fake = fakeClient(baseTables());
    callerClient.mockResolvedValue(fake.client);
    const res = await docPOST(req("POST", { file: PDF, fileName: "Plan sheet 2.pdf", officeOnly: true }), ctx({}));
    expect(res.status).toBe(200);
    expect(fake.uploads[0].path).toMatch(new RegExp(`^${JOB}/\\d+_Plan_sheet_2\\.pdf$`));
    expect(fake.uploads[0].contentType).toBe("application/pdf");
    const row = fake.ops.find((o) => o.table === "job_documents" && o.action === "insert")!;
    expect(row.payload).toMatchObject({ job_id: JOB, uploaded_by: "office-user", file_name: "Plan_sheet_2.pdf", file_type: "application/pdf", office_only: true });
    expect(adminClient).not.toHaveBeenCalled();
  });

  it("refuses a file that isn't a photo or a PDF", async () => {
    callerClient.mockResolvedValue(fakeClient(baseTables()).client);
    const res = await docPOST(req("POST", { file: Buffer.alloc(300, 65).toString("base64") }), ctx({}));
    expect(res.status).toBe(400);
    expect(callerClient).not.toHaveBeenCalled();
  });

  it("sets office only", async () => {
    const fake = fakeClient(baseTables());
    callerClient.mockResolvedValue(fake.client);
    const res = await docPATCH(req("PATCH", { officeOnly: true }), ctx({ docId: ORDER }));
    expect(res.status).toBe(200);
    expect(fake.ops.find((o) => o.action === "update")!.payload).toEqual({ office_only: true });
  });

  it("files an upload in Site Documents by default, or the folder asked for (0114)", async () => {
    const fake = fakeClient(baseTables());
    callerClient.mockResolvedValue(fake.client);
    await docPOST(req("POST", { file: PDF, fileName: "a.pdf" }), ctx({}));
    await docPOST(req("POST", { file: PDF, fileName: "b.pdf", folder: "soil" }), ctx({}));
    await docPOST(req("POST", { file: PDF, fileName: "c.pdf", folder: "other" }), ctx({}));
    const rows = fake.ops.filter((o) => o.table === "job_documents" && o.action === "insert").map((o) => (o.payload as { folder: unknown }).folder);
    expect(rows).toEqual(["site_documents", "soil", null]);
  });

  it("refuses an unknown folder before touching storage", async () => {
    const fake = fakeClient(baseTables());
    callerClient.mockResolvedValue(fake.client);
    const res = await docPOST(req("POST", { file: PDF, fileName: "a.pdf", folder: "invoices" }), ctx({}));
    expect(res.status).toBe(400);
    expect(fake.uploads).toEqual([]);
  });

  it("moves a document to another folder, or back to Other", async () => {
    const fake = fakeClient(baseTables());
    callerClient.mockResolvedValue(fake.client);
    const res = await docPATCH(req("PATCH", { folder: "drainage" }), ctx({ docId: ORDER }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ folder: "drainage" });
    await docPATCH(req("PATCH", { folder: null }), ctx({ docId: ORDER }));
    const updates = fake.ops.filter((o) => o.action === "update").map((o) => o.payload);
    expect(updates).toEqual([{ folder: "drainage" }, { folder: null }]);
    expect((await docPATCH(req("PATCH", { folder: "money" }), ctx({ docId: ORDER }))).status).toBe(400);
    expect((await docPATCH(req("PATCH", {}), ctx({ docId: ORDER }))).status).toBe(400);
  });
});

describe("rules", () => {
  it("linesInUse: supplier orders, then time, then expenses", () => {
    expect(linesInUse(["a", "b", "c", "d"], { a: 1 }, { a: 2, b: 3 }, { b: 1, c: 5 })).toEqual({
      a: "it has supplier orders against it.",
      b: "time is logged against it.",
      c: "expenses are recorded against it.",
    });
  });

  it("usageByLine leaves travel out", () => {
    expect(
      usageByLine(
        [
          { cost_center_id: "a", hours: 2, entry_type: "work" },
          { cost_center_id: "a", hours: 5, entry_type: "travel" },
          { cost_center_id: null, hours: 1 },
        ],
        [{ cost_center_id: "a", amount: "12.5" }]
      )
    ).toEqual({ hoursByLine: { a: 2 }, spentByLine: { a: 12.5 } });
  });

  it("poSiteCoords: keeps a PO's pin, takes the job site's, else none", () => {
    const site = { address: "7 Pony Promenade", lat: 1, lng: 2 };
    expect(poSiteCoords("7 Pony Promenade", site)).toEqual({ site_lat: 1, site_lng: 2 });
    expect(poSiteCoords("Elsewhere", site)).toEqual({ site_lat: null, site_lng: null });
    expect(poSiteCoords("Elsewhere", site, { site_address: "Elsewhere", site_lat: 5, site_lng: 6 })).toEqual({ site_lat: 5, site_lng: 6 });
  });

  it("decodeUploadedFile sniffs the bytes", () => {
    expect(decodeUploadedFile(JPEG)).toMatchObject({ ok: true, contentType: "image/jpeg", ext: "jpg" });
    expect(decodeUploadedFile(PDF)).toMatchObject({ ok: true, contentType: "application/pdf", ext: "pdf" });
    expect(decodeUploadedFile("x".repeat(4_200_004)).ok).toBe(false);
  });

  it("supplier invoice files carry the expense-receipt- marker technicians are kept from", () => {
    expect(supplierInvoicePath("job", "PO-1/2", safeFileName("my invoice.PDF", "pdf"), 5)).toBe("job/expense-receipt-PO-1_2-5_my_invoice.pdf");
  });

  it("parseMoney", () => {
    expect(parseMoney("$1,234.567")).toBe(1234.57);
    expect(parseMoney("-1")).toBeNull();
    expect(parseMoney("")).toBeNull();
  });
});
