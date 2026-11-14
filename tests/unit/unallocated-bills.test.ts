import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  classifyBill, coverageByMonth, unallocatedSummary, hasJobReference, loadBills,
  type ClassifiedBill, type MirrorBill,
} from "@/lib/unallocated-bills";
import { buildDigest } from "@/lib/weekly-digest";

// Which supplier bills in Xero can be traced to a job — the rules the report,
// the Monday email and the "is the data there" answer all rest on.

const bill = (over: Partial<MirrorBill> = {}): MirrorBill => ({
  xero_invoice_id: "b-1", invoice_number: "INV-9", reference: null, contact_name: "Reece",
  status: "AUTHORISED", invoice_date: "2026-10-10", sub_total: 100, ...over,
});
const ctx = (crm: string[] = [], allocs: [string, "job" | "overhead"][] = []) => ({
  crmBillIds: new Set(crm), allocations: new Map(allocs),
});

describe("classifyBill", () => {
  it("a bill the app made is 'crm'", () => {
    expect(classifyBill(bill(), ctx(["b-1"]))).toBe("crm");
  });
  it("what the app knows beats what the office decided", () => {
    expect(classifyBill(bill(), ctx(["b-1"], [["b-1", "overhead"]]))).toBe("crm");
  });
  it("an office assignment is 'manual'; an overhead mark is 'overhead'", () => {
    expect(classifyBill(bill(), ctx([], [["b-1", "job"]]))).toBe("manual");
    expect(classifyBill(bill(), ctx([], [["b-1", "overhead"]]))).toBe("overhead");
  });
  it("a PO-/JOB- reference alone is 'referenced'; nothing is 'unallocated'", () => {
    expect(classifyBill(bill({ reference: "PO-1234 / JOB-833" }), ctx())).toBe("referenced");
    expect(classifyBill(bill({ reference: "statement" }), ctx())).toBe("unallocated");
    expect(classifyBill(bill({ reference: null }), ctx())).toBe("unallocated");
  });
  it("reference matching is not fooled by look-alikes", () => {
    expect(hasJobReference("po 77")).toBe(true);
    expect(hasJobReference("POST OFFICE")).toBe(false);
    expect(hasJobReference("JOBSITE")).toBe(false);
    expect(hasJobReference("SUPPORT-12")).toBe(false);
  });
});

const cb = (cls: ClassifiedBill["cls"], sub_total: number, invoice_date = "2026-10-10", id = Math.random().toString()): ClassifiedBill =>
  ({ ...bill({ xero_invoice_id: id, sub_total, invoice_date }), cls });

describe("coverageByMonth / unallocatedSummary", () => {
  it("traced % is job spend traced to a job, with overheads left out of both sides", () => {
    const [oct] = coverageByMonth([cb("crm", 600), cb("manual", 100), cb("referenced", 100), cb("unallocated", 200), cb("overhead", 1000)]);
    expect(oct).toMatchObject({ month: "2026-10", total: 2000, tracedPct: 80 });
    expect(oct.byClass).toMatchObject({ crm: 600, manual: 100, referenced: 100, unallocated: 200, overhead: 1000 });
  });
  it("a month of only overheads has no percentage; months sort oldest first; undated bills are skipped", () => {
    const m = coverageByMonth([cb("overhead", 50, "2026-09-02"), cb("crm", 10, "2026-08-02"), { ...cb("crm", 999), invoice_date: null }]);
    expect(m.map((x) => x.month)).toEqual(["2026-08", "2026-09"]);
    expect(m[1].tracedPct).toBeNull();
    expect(m.reduce((s, x) => s + x.total, 0)).toBe(60);
  });
  it("summary lists only unallocated, oldest first, with the total", () => {
    const s = unallocatedSummary([cb("unallocated", 30, "2026-10-05", "new"), cb("crm", 999), cb("unallocated", 20.5, "2026-08-01", "old")]);
    expect(s.count).toBe(2);
    expect(s.total).toBe(50.5);
    expect(s.bills.map((b) => b.xero_invoice_id)).toEqual(["old", "new"]);
  });
});

// A fake PostgREST client: every select chain ends in .range() → rows for that table.
function fakeClient(tables: Record<string, { rows?: unknown[]; error?: string }>) {
  return {
    from(table: string) {
      const t = tables[table] ?? { rows: [] };
      const chain: any = {};
      for (const m of ["select", "eq", "in", "gte", "not", "order"]) chain[m] = () => chain;
      chain.range = () => Promise.resolve(t.error ? { data: null, error: { message: t.error } } : { data: t.rows ?? [], error: null, count: (t.rows ?? []).length });
      return chain;
    },
  } as never;
}

describe("loadBills", () => {
  it("classifies from the bills the app made and the office's decisions", async () => {
    const r = await loadBills(fakeClient({
      xero_invoices: { rows: [
        { ...bill({ xero_invoice_id: "a" }), sub_total: "100.00" },
        bill({ xero_invoice_id: "b" }), bill({ xero_invoice_id: "c" }), bill({ xero_invoice_id: "d", reference: "PO-5" }),
      ] },
      vendor_orders: { rows: [{ xero_bill_id: "a" }] },
      job_expenses: { rows: [] },
      xero_bill_allocations: { rows: [{ xero_invoice_id: "b", kind: "job" }, { xero_invoice_id: "c", kind: "overhead" }] },
    }));
    expect(r.ok && r.bills.map((x) => [x.xero_invoice_id, x.cls, x.sub_total])).toEqual([
      ["a", "crm", 100], ["b", "manual", 100], ["c", "overhead", 100], ["d", "referenced", 100],
    ]);
  });

  it("a failed read is an error, never a shorter list; missing tables are named as such", async () => {
    const failed = await loadBills(fakeClient({ xero_invoices: { rows: [bill()] }, vendor_orders: { error: "boom" } }));
    expect(failed).toMatchObject({ ok: false, tablesMissing: false });
    const noTables = await loadBills(fakeClient({ xero_invoices: { error: 'relation "xero_invoices" does not exist' } }));
    expect(noTables).toMatchObject({ ok: false, tablesMissing: true });
  });
});

describe("buildDigest", () => {
  const input = (count: number) => ({
    appUrl: "https://app.test",
    unallocated: unallocatedSummary(Array.from({ length: count }, (_, i) => cb("unallocated", 100, "2026-10-01", `u${i}`))),
    coverage: coverageByMonth([cb("crm", 90), cb("unallocated", 10)]),
    overdue: { count: 1, total: 500, top: [{ customer: "A & B <Builders>", invoiceNumber: 12, dueDate: "2026-10-01", balance: 500 }] },
    awaitingInvoice: { count: 2, oldest: [{ poNumber: "PO-1001", supplier: "Reece", orderedOn: "2026-11-01" }] },
  });

  it("leads with what needs doing and links to the report", () => {
    const d = buildDigest(input(12));
    expect(d.subject).toBe("Weekly office summary — 12 bills ($1,200) need a job");
    expect(d.text).toContain("and 4 more");
    expect(d.text).toContain("https://app.test/dashboard/reports/unallocated-bills");
    expect(d.text).toContain("90% of job spend traced");
  });
  it("says so when everything is allocated, and escapes names in the HTML", () => {
    expect(buildDigest(input(0)).subject).toBe("Weekly office summary — every bill is allocated");
    const html = buildDigest(input(1)).html;
    expect(html).toContain("A &amp; B &lt;Builders&gt;");
    expect(html).not.toContain("<Builders>");
  });
});

// ── routes ───────────────────────────────────────────────────────────────────

const requireOfficeOrAdmin = vi.fn((..._a: unknown[]) => undefined as unknown);
const requireCronSecret = vi.fn((..._a: unknown[]) => undefined as unknown);
const callerClient = vi.fn((..._a: unknown[]) => undefined as unknown);
const send = vi.fn(async (..._a: unknown[]) => ({ error: null }));
vi.mock("@/lib/api/guards", () => ({
  requireOfficeOrAdmin: (...a: unknown[]) => requireOfficeOrAdmin(...a),
  requireCronSecret: (...a: unknown[]) => requireCronSecret(...a),
}));
vi.mock("@/lib/api/caller-client", () => ({ callerClient: (...a: unknown[]) => callerClient(...a) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/resend", () => ({ getResend: () => ({ emails: { send } }), getFromAddress: () => "x@test" }));

const refuse = (status: number) => ({ ok: false, response: NextResponse.json({ error: "x" }, { status }) });
const post = (body: unknown) => new NextRequest("https://app.test/api/xero/bills/b-1/allocate", { method: "POST", body: JSON.stringify(body) });
const ctxP = { params: Promise.resolve({ id: "b-1" }) };

function allocClient(opts: { bill?: { type: string } | null; job?: { id: string } | null }) {
  const upsert = vi.fn(async () => ({ error: null }));
  const client = {
    from(table: string) {
      const one = (data: unknown) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }) });
      if (table === "xero_invoices") return one(opts.bill === undefined ? { xero_invoice_id: "b-1", type: "ACCPAY" } : opts.bill);
      if (table === "jobs") return one(opts.job === undefined ? { id: "job-uuid" } : opts.job);
      return { upsert };
    },
  };
  return { client, upsert };
}

beforeEach(() => vi.clearAllMocks());

describe("allocate route", () => {
  it("is office/admin only — refused before any database read", async () => {
    const { POST } = await import("@/app/api/xero/bills/[id]/allocate/route");
    requireOfficeOrAdmin.mockResolvedValue(refuse(403));
    expect((await POST(post({ kind: "overhead" }), ctxP)).status).toBe(403);
    expect(callerClient).not.toHaveBeenCalled();
  });

  it("assigns a bill to a job by number, resolving the job server-side", async () => {
    const { POST } = await import("@/app/api/xero/bills/[id]/allocate/route");
    const { client, upsert } = allocClient({});
    requireOfficeOrAdmin.mockResolvedValue({ ok: true });
    callerClient.mockResolvedValue(client);
    const res = await POST(post({ kind: "job", jobNumber: 833, amount: 99999 }), ctxP);
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ xero_invoice_id: "b-1", kind: "job", job_id: "job-uuid" }), { onConflict: "xero_invoice_id" });
    expect(JSON.stringify(upsert.mock.calls[0])).not.toContain("99999"); // amounts are never taken from the request
  });

  it("rejects a missing/unknown job, a non-bill, and a bad kind", async () => {
    const { POST } = await import("@/app/api/xero/bills/[id]/allocate/route");
    requireOfficeOrAdmin.mockResolvedValue({ ok: true });
    callerClient.mockResolvedValue(allocClient({ job: null }).client);
    expect((await POST(post({ kind: "job", jobNumber: 1 }), ctxP)).status).toBe(404);
    callerClient.mockResolvedValue(allocClient({}).client);
    expect((await POST(post({ kind: "job", jobNumber: "abc" }), ctxP)).status).toBe(400);
    callerClient.mockResolvedValue(allocClient({ bill: { type: "ACCREC" } }).client);
    expect((await POST(post({ kind: "overhead" }), ctxP)).status).toBe(404);
    expect((await POST(post({ kind: "nonsense" }), ctxP)).status).toBe(400);
  });
});

describe("weekly digest route", () => {
  const get = () => new NextRequest("https://app.test/api/reports/weekly-digest");

  it("needs the cron secret", async () => {
    const { GET } = await import("@/app/api/reports/weekly-digest/route");
    requireCronSecret.mockReturnValue(refuse(401));
    expect((await GET(get())).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("with no recipients configured it skips rather than guessing an address", async () => {
    const { GET } = await import("@/app/api/reports/weekly-digest/route");
    requireCronSecret.mockReturnValue({ ok: true });
    delete process.env.WEEKLY_DIGEST_TO;
    expect(await (await GET(get())).json()).toMatchObject({ skipped: true });
    expect(send).not.toHaveBeenCalled();
  });
});
