import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// The Xero analytics mirror (migration 0098): pure mapping, the P&L report
// parser, the resumable sync loop, and the route's authorisation.

const getInvoices = vi.fn();
const getPayments = vi.fn();
const getReportProfitAndLoss = vi.fn();
vi.mock("@/lib/xero", () => ({
  getRefreshedXero: vi.fn(async () => ({
    xero: { accountingApi: { getInvoices, getPayments, getReportProfitAndLoss } },
    tenantId: "tenant-1",
  })),
}));

import {
  invoiceRow, paymentRow, monthFromHeader, parsePlReport, plWindows, toDateOnly,
  isRateLimited, syncXeroAnalytics, AnalyticsTablesMissing,
} from "@/lib/xero-analytics";

beforeEach(() => vi.clearAllMocks());

const inv = (over: Record<string, unknown> = {}) => ({
  invoiceID: "i-1", type: "ACCREC", invoiceNumber: "INV-1001", reference: "JOB-833",
  contact: { contactID: "c-1", name: "Builder Pty Ltd" }, status: "PAID",
  date: "2026-09-01T00:00:00", dueDate: "2026-09-30", fullyPaidOnDate: "2026-10-05",
  subTotal: 1000, totalTax: 100, total: 1100, amountDue: 0, amountPaid: 1100, currencyCode: "AUD",
  updatedDateUTC: new Date("2026-10-05T01:00:00Z"), ...over,
});

describe("invoiceRow / paymentRow", () => {
  it("maps a paid sales invoice", () => {
    expect(invoiceRow(inv())).toEqual({
      xero_invoice_id: "i-1", type: "ACCREC", invoice_number: "INV-1001", reference: "JOB-833",
      xero_contact_id: "c-1", contact_name: "Builder Pty Ltd", status: "PAID",
      invoice_date: "2026-09-01", due_date: "2026-09-30", fully_paid_on: "2026-10-05",
      sub_total: 1000, total_tax: 100, total: 1100, amount_due: 0, amount_paid: 1100,
      currency_code: "AUD", xero_updated_at: "2026-10-05T01:00:00.000Z",
    });
  });

  it("keeps bills (ACCPAY) and skips rows with no id or an unknown type", () => {
    expect(invoiceRow(inv({ type: "ACCPAY" }))?.type).toBe("ACCPAY");
    expect(invoiceRow(inv({ invoiceID: undefined }))).toBeNull();
    expect(invoiceRow(inv({ type: "OTHER" }))).toBeNull();
  });

  it("treats missing money as 0 and a missing date as null", () => {
    const r = invoiceRow(inv({ total: undefined, amountDue: "x", date: undefined, fullyPaidOnDate: undefined }));
    expect(r).toMatchObject({ total: 0, amount_due: 0, invoice_date: null, fully_paid_on: null });
  });

  it("maps a payment", () => {
    expect(paymentRow({
      paymentID: "p-1", invoice: { invoiceID: "i-1" }, paymentType: "ACCRECPAYMENT",
      date: "2026-10-05", amount: 1100, reference: "EFT", status: "AUTHORISED", account: { code: "090" },
      updatedDateUTC: new Date("2026-10-05T02:00:00Z"),
    })).toEqual({
      xero_payment_id: "p-1", xero_invoice_id: "i-1", payment_type: "ACCRECPAYMENT", payment_date: "2026-10-05",
      amount: 1100, reference: "EFT", status: "AUTHORISED", account_code: "090", xero_updated_at: "2026-10-05T02:00:00.000Z",
    });
    expect(paymentRow({})).toBeNull();
  });

  it("toDateOnly reads strings and Dates", () => {
    expect(toDateOnly("2026-09-01T00:00:00")).toBe("2026-09-01");
    expect(toDateOnly(new Date("2026-09-01T00:00:00Z"))).toBe("2026-09-01");
    expect(toDateOnly("garbage")).toBeNull();
  });
});

describe("P&L parsing", () => {
  it("reads month headers", () => {
    expect(monthFromHeader("30 Nov 2026")).toBe("2026-11-01");
    expect(monthFromHeader("Nov 2026")).toBe("2026-11-01");
    expect(monthFromHeader("1 Oct 26 to 31 Oct 26")).toBe("2026-10-01");
    expect(() => monthFromHeader("Total")).toThrow(/Unrecognised/);
  });

  const report = {
    rows: [
      { rowType: "Header", cells: [{ value: "" }, { value: "31 Oct 2026" }, { value: "30 Sep 2026" }] },
      { rowType: "Section", title: "Income", rows: [
        { rowType: "Row", cells: [{ value: "Drainage", attributes: [{ id: "account", value: "a-1" }] }, { value: "1000.50" }, { value: "" }] },
        { rowType: "SummaryRow", cells: [{ value: "Total Income" }, { value: "1000.50" }, { value: "0" }] },
      ] },
      { rowType: "Section", title: "Less Operating Expenses", rows: [
        { rowType: "Row", cells: [{ value: "Fuel" }, { value: "200" }, { value: "150" }] },
      ] },
      { rowType: "Section", title: "", rows: [{ rowType: "Row", cells: [{ value: "Net Profit" }, { value: "800.50" }, { value: "-150" }] }] },
    ],
  };

  it("flattens to one row per account per month, skipping totals and untitled sections", () => {
    expect(parsePlReport(report)).toEqual([
      { month: "2026-10-01", section: "Income", account_name: "Drainage", xero_account_id: "a-1", amount: 1000.5 },
      { month: "2026-09-01", section: "Income", account_name: "Drainage", xero_account_id: "a-1", amount: 0 },
      { month: "2026-10-01", section: "Less Operating Expenses", account_name: "Fuel", xero_account_id: null, amount: 200 },
      { month: "2026-09-01", section: "Less Operating Expenses", account_name: "Fuel", xero_account_id: null, amount: 150 },
    ]);
  });

  it("refuses a report with no header rather than guessing months", () => {
    expect(() => parsePlReport({ rows: [] })).toThrow(/no header/);
  });

  it("windows: 24 months = two 12-column requests, 3 months = one", () => {
    const now = new Date("2026-11-14T00:00:00Z");
    expect(plWindows(now, 24)).toEqual([
      { fromDate: "2026-11-01", toDate: "2026-11-30", periods: 11 },
      { fromDate: "2025-11-01", toDate: "2025-11-30", periods: 11 },
    ]);
    expect(plWindows(now, 3)).toEqual([{ fromDate: "2026-11-01", toDate: "2026-11-30", periods: 2 }]);
  });
});

// ── the sync loop ────────────────────────────────────────────────────────────

function fakeAdmin(opts: { state?: { entity: string; cursor: string | null }[]; plCount?: number; missing?: boolean } = {}) {
  const writes: { table: string; rows: any }[] = [];
  const states: any[] = [];
  const admin = {
    from(table: string) {
      return {
        select: (_c?: string, o?: { head?: boolean }) => {
          if (opts.missing) return Promise.resolve({ data: null, error: { code: "42P01", message: 'relation "xero_sync_state" does not exist' } });
          if (table === "xero_pl_monthly" && o?.head) return Promise.resolve({ count: opts.plCount ?? 0, error: null });
          return Promise.resolve({ data: opts.state ?? [], error: null });
        },
        upsert: (rows: any) => {
          if (table === "xero_sync_state") states.push(rows);
          else writes.push({ table, rows });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { admin: admin as never, writes, states };
}

const emptyReport = { body: { reports: [{ rows: [{ rowType: "Header", cells: [{ value: "" }, { value: "30 Nov 2026" }] }] }] } };

describe("syncXeroAnalytics", () => {
  it("first run is a backfill: no resume point, 24 months of P&L, cursor saved", async () => {
    const { admin, writes, states } = fakeAdmin();
    getInvoices.mockResolvedValue({ body: { invoices: [inv()] } });
    getPayments.mockResolvedValue({ body: { payments: [] } });
    getReportProfitAndLoss.mockResolvedValue(emptyReport);

    const r = await syncXeroAnalytics(admin, { now: new Date("2026-11-14T00:00:00Z") });

    expect(r.invoices).toEqual({ rows: 1, done: true });
    expect(getInvoices.mock.calls[0][1]).toBeUndefined(); // no ifModifiedSince yet
    expect(getInvoices.mock.calls[0][2]).toBe("Date >= DateTime(2024, 11, 1)");
    expect(getInvoices.mock.calls[0][3]).toBe("UpdatedDateUTC ASC");
    expect(getInvoices.mock.calls[0][12]).toBe(true); // summaryOnly: no line items
    expect(getReportProfitAndLoss).toHaveBeenCalledTimes(2);
    expect(writes.find((w) => w.table === "xero_invoices")?.rows[0].xero_invoice_id).toBe("i-1");
    expect(states.find((s) => s.entity === "invoices")).toMatchObject({ cursor: "2026-10-05T01:00:00.000Z", last_error: null });
  });

  it("later runs resume from the saved cursor and only refresh recent P&L months", async () => {
    const { admin } = fakeAdmin({ state: [{ entity: "invoices", cursor: "2026-11-01T00:00:00.000Z" }], plCount: 500 });
    getInvoices.mockResolvedValue({ body: { invoices: [] } });
    getPayments.mockResolvedValue({ body: { payments: [] } });
    getReportProfitAndLoss.mockResolvedValue(emptyReport);

    await syncXeroAnalytics(admin, { now: new Date("2026-11-14T00:00:00Z") });

    expect(getInvoices.mock.calls[0][1]).toEqual(new Date("2026-11-01T00:00:00.000Z"));
    expect(getReportProfitAndLoss).toHaveBeenCalledTimes(1);
  });

  it("pages until a short page", async () => {
    const { admin } = fakeAdmin({ plCount: 1 });
    const full = Array.from({ length: 100 }, (_, i) => inv({ invoiceID: `i-${i}` }));
    getInvoices.mockResolvedValueOnce({ body: { invoices: full } }).mockResolvedValueOnce({ body: { invoices: [inv({ invoiceID: "last" })] } });
    getPayments.mockResolvedValue({ body: { payments: [] } });
    getReportProfitAndLoss.mockResolvedValue(emptyReport);

    const r = await syncXeroAnalytics(admin);
    expect(getInvoices).toHaveBeenCalledTimes(2);
    expect(getInvoices.mock.calls[1][8]).toBe(2); // page 2
    expect(r.invoices).toEqual({ rows: 101, done: true });
  });

  it("a Xero rate limit stops that entity cleanly, keeping its resume point", async () => {
    const { admin, states } = fakeAdmin({ plCount: 1 });
    getInvoices.mockRejectedValue({ response: { statusCode: 429 } });
    getPayments.mockResolvedValue({ body: { payments: [] } });
    getReportProfitAndLoss.mockResolvedValue(emptyReport);

    const r = await syncXeroAnalytics(admin);
    expect(r.invoices).toMatchObject({ done: false, rateLimited: true });
    expect(states.find((s) => s.entity === "invoices")?.last_error).toMatch(/rate limit/);
    expect(isRateLimited({ response: { statusCode: 429 } })).toBe(true);
    expect(isRateLimited(new Error("boom"))).toBe(false);
  });

  it("a real Xero error is thrown (and recorded), never swallowed", async () => {
    const { admin, states } = fakeAdmin({ plCount: 1 });
    getInvoices.mockRejectedValue(new Error("Forbidden: missing scope"));
    await expect(syncXeroAnalytics(admin)).rejects.toThrow(/missing scope/);
    expect(states.find((s) => s.entity === "invoices")?.last_error).toMatch(/missing scope/);
  });

  it("migration 0098 not applied → a named error, no Xero calls", async () => {
    const { admin } = fakeAdmin({ missing: true });
    await expect(syncXeroAnalytics(admin)).rejects.toBeInstanceOf(AnalyticsTablesMissing);
    expect(getInvoices).not.toHaveBeenCalled();
  });
});

// ── route authorisation ──────────────────────────────────────────────────────

const requireAdmin = vi.fn((..._a: unknown[]) => undefined as unknown);
const requireCronSecret = vi.fn((..._a: unknown[]) => undefined as unknown);
vi.mock("@/lib/api/guards", () => ({
  requireAdmin: (...a: unknown[]) => requireAdmin(...a),
  requireCronSecret: (...a: unknown[]) => requireCronSecret(...a),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));

describe("sync-analytics route — authorisation", () => {
  const req = (method: string) => new NextRequest("https://app.test/api/xero/sync-analytics", { method });
  const refuse = (status: number) => ({ ok: false, response: NextResponse.json({ error: "x" }, { status }) });

  it("cron GET without the secret → 401, Xero untouched", async () => {
    const { GET } = await import("@/app/api/xero/sync-analytics/route");
    requireCronSecret.mockReturnValue(refuse(401));
    expect((await GET(req("GET"))).status).toBe(401);
    expect(getInvoices).not.toHaveBeenCalled();
  });

  it("manual POST is admin-only: office/technician → 403, Xero untouched", async () => {
    const { POST } = await import("@/app/api/xero/sync-analytics/route");
    requireAdmin.mockResolvedValue(refuse(403));
    expect((await POST(req("POST"))).status).toBe(403);
    expect(requireCronSecret).not.toHaveBeenCalled();
    expect(getInvoices).not.toHaveBeenCalled();
  });
});
