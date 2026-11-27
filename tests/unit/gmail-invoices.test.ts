import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// Supplier invoices from Gmail (0124, drafted): the pure rules, the Gmail
// client's error handling, and the hourly import against an in-memory
// database, a fake Gmail and a fake reader (no live Gmail or Anthropic here).

vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn(), reportFailure: vi.fn() }));
vi.mock("@/lib/google", () => ({ getGoogleAuthClient: vi.fn(async () => null) }));

import {
  checkRead,
  classifyGmailFailure,
  decideMatch,
  googleErrorReasons,
  grantsGmailRead,
  jobDocumentPath,
  pickAttachments,
  searchAfterSeconds,
  SENTENCES,
  typedPoNumber,
  type CandidateOrder,
  type GmailMessage,
} from "@/lib/gmail-invoice-rules";
import { gmailApi, GmailHttpError, GmailTablesMissing, importGmailInvoices, type GmailApi } from "@/lib/gmail-invoices";
import type { ReadInvoice } from "@/lib/supplier-invoice-read";

const TODAY = "2026-11-27";

const invoice = (over: Partial<ReadInvoice> = {}): ReadInvoice => ({
  doc_kind: "invoice",
  supplier_name: "Reece Pty Ltd",
  supplier_abn: null,
  invoice_number: "INV-77",
  invoice_date: "2026-11-20",
  amount_ex_gst: 200,
  gst_amount: 20,
  total: 220,
  order_refs: ["PO-1008"],
  job_refs: [],
  site_text: null,
  ...over,
});

const order = (over: Partial<CandidateOrder> = {}): CandidateOrder => ({
  id: "o1",
  po_number: "PO-1008",
  job_id: "j1",
  vendor_name: "Reece",
  status: "ordered",
  invoice_number: null,
  xero_bill_id: null,
  ...over,
});

// ---------------------------------------------------------------- rules

describe("pickAttachments", () => {
  it("takes PDFs and real photos, skips logos and unnamed parts, walks nested parts", () => {
    const msg: GmailMessage = {
      id: "m",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          { partId: "0", mimeType: "text/plain", body: { size: 10, data: "aGk" } },
          { partId: "1", mimeType: "application/pdf", filename: "inv.pdf", body: { attachmentId: "A", size: 50_000 } },
          { partId: "2", mimeType: "image/png", filename: "logo.png", body: { attachmentId: "B", size: 4_000 } },
          {
            partId: "3",
            mimeType: "multipart/related",
            parts: [
              { partId: "3.1", mimeType: "application/octet-stream", filename: "scan.PDF", body: { attachmentId: "C", size: 90_000 } },
              { partId: "3.2", mimeType: "image/jpeg", filename: "photo.jpg", body: { data: "abc", size: 80_000 } },
              { partId: "3.3", mimeType: "application/zip", filename: "x.zip", body: { attachmentId: "D", size: 80_000 } },
            ],
          },
        ],
      },
    };
    const got = pickAttachments(msg);
    expect(got.map((a) => [a.partId, a.mimeType])).toEqual([
      ["1", "application/pdf"],
      ["3.1", "application/pdf"],
      ["3.2", "image/jpeg"],
    ]);
    expect(got[2].inlineData).toBe("abc");
    expect(got[0].attachmentId).toBe("A");
  });
});

describe("checkRead", () => {
  it("passes a clean single invoice and finds our PO", () => {
    const { fields, problem } = checkRead([invoice()], TODAY);
    expect(problem).toBeNull();
    expect(fields.po_refs).toEqual(["PO-1008"]);
  });
  it("derives 10% GST when none is printed", () => {
    const { fields, problem } = checkRead([invoice({ gst_amount: null, total: null })], TODAY);
    expect(problem).toBeNull();
    expect(fields.gst_amount).toBe(20);
  });
  it.each([
    ["several documents", [invoice(), invoice()], /2 documents/],
    ["a credit note", [invoice({ doc_kind: "credit_note" })], /credit note/],
    ["a statement", [invoice({ doc_kind: "statement" })], /statement/],
    ["no invoice number", [invoice({ invoice_number: null })], /invoice number/],
    ["no amount", [invoice({ amount_ex_gst: null })], /amount/],
    ["a zero amount", [invoice({ amount_ex_gst: 0 })], /amount/],
    ["GST not 10%", [invoice({ gst_amount: 5, total: 205 })], /GST isn't 10%/],
    ["a total that doesn't add up", [invoice({ total: 300 })], /don't add up/],
    ["a future date", [invoice({ invoice_date: "2026-12-30" })], /future/],
    ["an ancient date", [invoice({ invoice_date: "2023-01-01" })], /two years/],
    ["nothing", [], /Nothing could be read/],
  ])("refuses %s", (_n, reads, re) => {
    expect(checkRead(reads as ReadInvoice[], TODAY).problem).toMatch(re);
  });
});

describe("decideMatch", () => {
  const ok = () => checkRead([invoice()], TODAY);
  it("matches exactly one open PO of ours with the same supplier", () => {
    const { fields, problem } = ok();
    expect(decideMatch(fields, problem, [order()], false)).toEqual({ kind: "matched", order: order() });
  });
  it.each([
    ["no PO printed", invoice({ order_refs: ["JOHN SMITH"] }), [order()], false, /No PO number/],
    ["a PO that isn't ours", invoice(), [], false, /isn't one of our/],
    ["two of our POs", invoice({ order_refs: ["PO-1008", "PO-1009"] }), [order(), order({ id: "o2", po_number: "PO-1009" })], false, /more than one/],
    ["a PO that already has an invoice", invoice(), [order({ invoice_number: "X-1" })], false, /already has invoice X-1/],
    ["the same invoice already entered", invoice(), [order({ invoice_number: "inv-77" })], false, /already entered/],
    ["a PO in Xero", invoice(), [order({ xero_bill_id: "B" })], false, /Xero/],
    ["a cancelled PO", invoice(), [order({ status: "cancelled" })], false, /cancelled/],
    ["another supplier's PO", invoice({ supplier_name: "Tradelink" }), [order()], false, /is with Reece/],
    ["a duplicate invoice number", invoice(), [order()], true, /already received/],
  ])("sends %s to review", (_n, read, orders, dup, re) => {
    const { fields, problem } = checkRead([read as ReadInvoice], TODAY);
    const d = decideMatch(fields, problem, orders as CandidateOrder[], dup as boolean);
    expect(d.kind).toBe("review");
    expect(d.kind === "review" && d.reason).toMatch(re as RegExp);
  });
});

describe("small helpers", () => {
  it("knows our PO numbers however they are typed", () => {
    expect(typedPoNumber("1234")).toBe("PO-1234");
    expect(typedPoNumber("po 1234")).toBe("PO-1234");
    expect(typedPoNumber("hello")).toBeNull();
  });
  it("keeps the PO tab's money-file path shape", () => {
    expect(jobDocumentPath("j1", "PO-1008", "My Invoice (1).pdf", 5)).toBe("j1/expense-receipt-PO-1008-5_My_Invoice_1_.pdf");
  });
  it("looks back 7 days the first time, a day before the last message after", () => {
    const now = new Date("2026-11-27T00:00:00Z");
    expect(searchAfterSeconds(null, now)).toBe(Date.parse("2026-11-20T00:00:00Z") / 1000);
    expect(searchAfterSeconds("2026-11-26T12:00:00Z", now)).toBe(Date.parse("2026-11-25T12:00:00Z") / 1000);
  });
  it("tells a missing scope from other refusals, by Google's enumerated reasons only", () => {
    const body = { error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }], details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } };
    const reasons = googleErrorReasons(body);
    expect(reasons).not.toContain("Request had insufficient authentication scopes.");
    expect(classifyGmailFailure(403, reasons)).toBe("scope");
    expect(classifyGmailFailure(403, ["accessNotConfigured"])).toBe("api_disabled");
    expect(classifyGmailFailure(401, [])).toBe("auth");
    expect(classifyGmailFailure(500, [])).toBe("other");
  });
  it("reads the granted scopes", () => {
    expect(grantsGmailRead("https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.readonly")).toBe(true);
    expect(grantsGmailRead("https://www.googleapis.com/auth/calendar.events")).toBe(false);
    expect(grantsGmailRead(undefined)).toBe(false);
  });
});

describe("gmailApi", () => {
  it("turns a 403 insufficient-scope answer into GmailHttpError(scope)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }), { status: 403 }),
    );
    const api = gmailApi("t", fetchImpl as unknown as typeof fetch);
    await expect(api.listLabels()).rejects.toMatchObject({ status: 403, kind: "scope" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/labels");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });
  it("pages the label's messages with after:", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.includes("pageToken") ? { messages: [{ id: "c" }] } : { messages: [{ id: "a" }, { id: "b" }], nextPageToken: "p" })),
    );
    const ids = await gmailApi("t", fetchImpl as unknown as typeof fetch).listMessageIds("L1", 1000, 50);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("q=after%3A1000");
    expect(String(fetchImpl.mock.calls[0][0])).toContain("labelIds=L1");
  });
});

// ---------------------------------------------------------------- the import

type Row = Record<string, unknown>;

/** A tiny in-memory PostgREST: enough of the builder for the import. */
function fakeDb(seed: Record<string, Row[]>, opts: { missing?: string[] } = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const storage: Record<string, Map<string, Buffer>> = {};
  let seq = 0;
  const from = (table: string) => {
    let op: "select" | "insert" | "update" = "select";
    let payload: Row | Row[] | null = null;
    let wantCount = false;
    let returning = false;
    const filters: ((r: Row) => boolean)[] = [];
    const b: Record<string, unknown> = {};
    const run = (): { data: unknown; error: unknown; count?: number } => {
      if (opts.missing?.includes(table)) return { data: null, error: { code: "42P01", message: "missing" } };
      const rows = (tables[table] ??= []);
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const out: Row[] = [];
        for (const p of list) {
          if (table === "gmail_supplier_invoices" && rows.some((r) => r.gmail_message_id === p.gmail_message_id && r.part_id === p.part_id)) {
            return { data: null, error: { code: "23505", message: "dup" } };
          }
          const row = { id: `row-${++seq}`, created_at: new Date().toISOString(), status: "new", ...p };
          rows.push(row);
          out.push(row);
        }
        return { data: returning ? out : null, error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of hit) Object.assign(r, payload);
        return { data: returning ? hit : null, error: null, count: wantCount ? hit.length : undefined };
      }
      return { data: hit, error: null };
    };
    Object.assign(b, {
      select: () => ((returning = op !== "select"), b),
      insert: (p: Row | Row[]) => ((op = "insert"), (payload = p), b),
      update: (p: Row, o?: { count?: string }) => ((op = "update"), (payload = p), (wantCount = !!o?.count), b),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
      lt: (c: string, v: string) => (filters.push((r) => String(r[c]) < v), b),
      ilike: (c: string, v: string) => (filters.push((r) => String(r[c] ?? "").toLowerCase() === v.toLowerCase()), b),
      maybeSingle: async () => {
        const r = run();
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
      },
      single: async () => {
        const r = run();
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
      },
      then: (ok: (r: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    });
    return b;
  };
  const db = {
    from,
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, file: Buffer) => ((storage[bucket] ??= new Map()).set(path, file), { data: { path }, error: null }),
        remove: async (paths: string[]) => (paths.forEach((p) => storage[bucket]?.delete(p)), { data: null, error: null }),
      }),
    },
  };
  return { db: db as unknown as SupabaseClient, tables, storage };
}

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2000, 1)]);
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

function fakeGmail(messages: Record<string, GmailMessage>, over: Partial<GmailApi> = {}): GmailApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listLabels: async () => (calls.push("labels"), [{ id: "L1", name: "Supplier Invoices" }]),
    listMessageIds: async () => (calls.push("list"), Object.keys(messages)),
    getMessage: async (id) => (calls.push(`get:${id}`), messages[id]),
    getAttachment: async (m, a) => (calls.push(`att:${m}:${a}`), b64url(PDF)),
    ...over,
  };
}

const mail = (id: string): GmailMessage => ({
  id,
  internalDate: String(Date.parse("2026-11-26T01:00:00Z")),
  payload: {
    headers: [{ name: "From", value: "accounts@reece.example" }, { name: "Subject", value: "Tax invoice" }],
    parts: [{ partId: "1", mimeType: "application/pdf", filename: "inv.pdf", body: { attachmentId: "A1", size: PDF.length } }],
  },
});

const settings = () => ({ id: true, label_name: "Supplier invoices", last_message_at: null, gmail_allowed: null, last_error: null });
const vendorOrder = (over: Row = {}): Row => ({ id: "o1", po_number: "PO-1008", job_id: "j1", vendor_name: "Reece", status: "ordered", invoice_number: null, xero_bill_id: null, ...over });
const now = () => new Date("2026-11-27T01:00:00Z");

describe("importGmailInvoices", () => {
  let read: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    read = vi.fn(async () => [invoice()]);
  });

  it("files a matched invoice on its PO, flagged for the office to check, file copied to the job", async () => {
    const { db, tables, storage } = fakeDb({ gmail_invoice_settings: [settings()], vendor_orders: [vendorOrder()] });
    const res = await importGmailInvoices({ db, gmail: fakeGmail({ m1: mail("m1") }), read, now });
    expect(res).toMatchObject({ messages: 1, files: 1, matched: 1, needsReview: 0 });
    const vo = tables.vendor_orders[0];
    expect(vo).toMatchObject({ invoice_number: "INV-77", amount: 200, gst_amount: 20, status: "received", invoice_needs_check: true });
    expect(String(vo.invoice_storage_path)).toMatch(/^j1\/expense-receipt-PO-1008-\d+_inv\.pdf$/);
    expect(storage["job-documents"].has(String(vo.invoice_storage_path))).toBe(true);
    const row = tables.gmail_supplier_invoices[0];
    expect(row).toMatchObject({ status: "matched", vendor_order_id: "o1", job_id: "j1", gmail_message_id: "m1", part_id: "1", sender: "accounts@reece.example" });
    expect(String(row.storage_path)).toMatch(/^gmail\/2026-11-27\/row-\d+\.pdf$/);
    expect(tables.gmail_invoice_settings[0]).toMatchObject({ gmail_allowed: true, last_error: null, last_message_at: "2026-11-26T01:00:00.000Z" });
  });

  it("never overwrites an invoice the office already entered", async () => {
    const { db, tables, storage } = fakeDb({ gmail_invoice_settings: [settings()], vendor_orders: [vendorOrder({ invoice_number: "TYPED-1", amount: 99 })] });
    const res = await importGmailInvoices({ db, gmail: fakeGmail({ m1: mail("m1") }), read, now });
    expect(res).toMatchObject({ matched: 0, needsReview: 1 });
    expect(tables.vendor_orders[0]).toMatchObject({ invoice_number: "TYPED-1", amount: 99 });
    expect(tables.vendor_orders[0].invoice_needs_check).toBeUndefined();
    expect(tables.gmail_supplier_invoices[0]).toMatchObject({ status: "needs_review", review_reason: "PO-1008 already has invoice TYPED-1." });
    expect(storage["job-documents"]).toBeUndefined();
  });

  it("is idempotent: a message already recorded is not fetched or read again", async () => {
    const { db, tables } = fakeDb({ gmail_invoice_settings: [settings()], vendor_orders: [vendorOrder()] });
    const gmail = fakeGmail({ m1: mail("m1") });
    await importGmailInvoices({ db, gmail, read, now });
    const second = fakeGmail({ m1: mail("m1") });
    const res = await importGmailInvoices({ db, gmail: second, read, now });
    expect(res.files).toBe(0);
    expect(second.calls.filter((c) => c.startsWith("get:"))).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(tables.gmail_supplier_invoices).toHaveLength(1);
  });

  it("records an email with nothing to read once, for review", async () => {
    const { db, tables } = fakeDb({ gmail_invoice_settings: [settings()] });
    const bare: GmailMessage = { id: "m2", payload: { headers: [], parts: [{ partId: "0", mimeType: "text/plain", body: { data: "aGk", size: 2 } }] } };
    await importGmailInvoices({ db, gmail: fakeGmail({ m2: bare }), read, now });
    expect(tables.gmail_supplier_invoices[0]).toMatchObject({ part_id: "-", status: "needs_review", review_reason: SENTENCES.noAttachment });
    expect(read).not.toHaveBeenCalled();
  });

  it("missing Gmail scope: asks for a reconnect and reads nothing", async () => {
    const { db, tables } = fakeDb({ gmail_invoice_settings: [settings()] });
    const gmail = fakeGmail({}, { listLabels: async () => { throw new GmailHttpError(403, "scope"); } });
    const res = await importGmailInvoices({ db, gmail, read, now });
    expect(res).toMatchObject({ skipped: true, reason: "scope" });
    expect(tables.gmail_invoice_settings[0]).toMatchObject({ gmail_allowed: false, last_error: SENTENCES.reconnect });
  });

  it("no label by that name, or Google not connected: says so", async () => {
    const a = fakeDb({ gmail_invoice_settings: [{ ...settings(), label_name: "Bills" }] });
    await importGmailInvoices({ db: a.db, gmail: fakeGmail({}), read, now });
    expect(a.tables.gmail_invoice_settings[0].last_error).toBe(SENTENCES.noLabel("Bills"));
    const b = fakeDb({ gmail_invoice_settings: [settings()] });
    const res = await importGmailInvoices({ db: b.db, gmail: null, read, now });
    expect(res.skipped).toBe(true);
    expect(b.tables.gmail_invoice_settings[0].last_error).toBe(SENTENCES.notConnected);
  });

  it("a reader answer that can't be trusted goes to review with the reason", async () => {
    const { db, tables } = fakeDb({ gmail_invoice_settings: [settings()], vendor_orders: [vendorOrder()] });
    read.mockResolvedValue([invoice({ gst_amount: 0, total: 200 })]);
    await importGmailInvoices({ db, gmail: fakeGmail({ m1: mail("m1") }), read, now });
    expect(tables.gmail_supplier_invoices[0]).toMatchObject({ status: "needs_review", amount_ex_gst: 200, vendor_order_id: "o1" });
    expect(String(tables.gmail_supplier_invoices[0].review_reason)).toMatch(/GST/);
    expect(tables.vendor_orders[0].invoice_number).toBeNull();
  });

  it("before 0124 (drafted) is applied: throws GmailTablesMissing", async () => {
    const { db } = fakeDb({}, { missing: ["gmail_invoice_settings"] });
    await expect(importGmailInvoices({ db, gmail: fakeGmail({}), read, now })).rejects.toBeInstanceOf(GmailTablesMissing);
  });
});
