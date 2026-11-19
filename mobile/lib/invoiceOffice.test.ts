// Office invoice / quote actions on the phone: online calls to the web routes
// with the user's Bearer token; the server's sentences come back as errors.

const mockGetSession = jest.fn();
const mockFetch = jest.fn();
jest.mock("./supabase", () => ({ supabase: { auth: { getSession: (...a: unknown[]) => mockGetSession(...a) } } }));
jest.mock("./fetchWithTimeout", () => ({ fetchWithTimeout: (...a: unknown[]) => mockFetch(...a) }));

process.env.EXPO_PUBLIC_API_BASE_URL = "https://office.example";

const o = require("./invoiceOffice") as typeof import("./invoiceOffice");

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  blob: async () => ({ b64: "JVBERi0=" }),
});

class FakeReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: { b64: string }) {
    this.result = `data:application/pdf;base64,${blob.b64}`;
    this.onload?.();
  }
}
(globalThis as unknown as { FileReader: unknown }).FileReader = FakeReader;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: { access_token: "tok-1" } } });
});

const lastCall = () => mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string, RequestInit];

describe("the routes it calls", () => {
  it("opens an invoice PDF with the Bearer token and returns its base64", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, {}));
    await expect(o.fetchDocumentPdf("invoice", "inv 1")).resolves.toBe("JVBERi0=");
    const [url, init] = lastCall();
    expect(url).toBe("https://office.example/api/invoices/inv%201/pdf");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
  });

  it("opens a quote PDF from the quote route", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, {}));
    await o.fetchDocumentPdf("quote", "q1");
    expect(lastCall()[0]).toBe("https://office.example/api/quotes/q1/pdf");
  });

  it("pushes to Xero with the confirm flag, and reports an update", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { success: true, updated: true }));
    await expect(o.pushInvoiceToXero("inv-1", true)).resolves.toEqual({ updated: true });
    const [url, init] = lastCall();
    expect(url).toBe("https://office.example/api/xero/push-invoice");
    expect(JSON.parse(String(init.body))).toEqual({ invoiceId: "inv-1", confirmUnpriced: true });
  });

  it("passes the server's refusal and its code through", async () => {
    mockFetch.mockResolvedValue(jsonResponse(409, { error: "2.00h on this job aren't on this invoice yet.", code: "unpriced_hours" }));
    const err = await o.pushInvoiceToXero("inv-1", false).catch((e) => e);
    expect(err).toBeInstanceOf(o.ApiError);
    expect(err.message).toBe("2.00h on this job aren't on this invoice yet.");
    expect(err.code).toBe("unpriced_hours");
    expect(err.status).toBe(409);
  });

  it("records, lists and removes payments on the invoice's routes", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ok: true, status: "paid", balance: 0 }));
    await o.recordInvoicePayment("inv-1", { amount: 50, paid_on: "2026-11-19", method: "cash", reference: null });
    expect(lastCall()[0]).toBe("https://office.example/api/invoices/inv-1/payments");
    expect(lastCall()[1].method).toBe("POST");
    expect(JSON.parse(String(lastCall()[1].body))).toEqual({ amount: 50, paid_on: "2026-11-19", method: "cash", reference: null });

    mockFetch.mockResolvedValue(jsonResponse(200, { invoice: {}, payments: [], xeroConnected: true }));
    await o.loadInvoicePayments("inv-1");
    expect(lastCall()[0]).toBe("https://office.example/api/invoices/inv-1/payments");

    mockFetch.mockResolvedValue(jsonResponse(200, { ok: true }));
    await o.removeInvoicePayment("inv-1", "pay-9");
    expect(lastCall()[0]).toBe("https://office.example/api/invoices/inv-1/payments/pay-9");
    expect(lastCall()[1].method).toBe("DELETE");
  });

  it("deletes an invoice on DELETE /api/invoices/[id] and says whether it was in Xero", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ok: true, inXero: true }));
    await expect(o.deleteInvoice("inv-1")).resolves.toEqual({ inXero: true });
    expect(lastCall()[0]).toBe("https://office.example/api/invoices/inv-1");
    expect(lastCall()[1].method).toBe("DELETE");
  });

  it("refuses a delete with the route's sentence (admin only on the server)", async () => {
    mockFetch.mockResolvedValue(jsonResponse(403, { error: "Insufficient permissions" }));
    await expect(o.deleteInvoice("inv-1")).rejects.toThrow("Insufficient permissions");
  });

  it("applies hours with the rates typed, and asks first when the server wants a confirm", async () => {
    mockFetch.mockResolvedValue(jsonResponse(409, { error: "This invoice is already in Xero.", code: "confirm_outside" }));
    const body = { mode: "all" as const, all: "120", byStaff: {}, byCostCentre: {}, confirmOutside: false };
    const err = await o.applyInvoiceHours("inv-1", body).catch((e) => e);
    expect(err.code).toBe("confirm_outside");
    expect(JSON.parse(String(lastCall()[1].body))).toEqual(body);
    expect(lastCall()[0]).toBe("https://office.example/api/invoices/inv-1/hours");
  });

  it("sends a quote to the address typed, trimmed", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { success: true, sentTo: "a@b.co" }));
    await expect(o.sendQuote("q1", "  a@b.co ", "Hi")).resolves.toEqual({ success: true, sentTo: "a@b.co" });
    expect(lastCall()[0]).toBe("https://office.example/api/quotes/q1/send");
    expect(JSON.parse(String(lastCall()[1].body))).toEqual({ to: "a@b.co", message: "Hi" });
  });

  it("says it needs signal when the request can't go", async () => {
    mockFetch.mockRejectedValue(new TypeError("Network request failed"));
    await expect(o.loadInvoiceHours("inv-1")).rejects.toThrow(o.OFFICE_ACTION_OFFLINE);
  });

  it("asks to sign in again without a session", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    await expect(o.deleteInvoice("inv-1")).rejects.toThrow(/session has expired/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("wording", () => {
  it("never puts a dollar figure in the hours alert", () => {
    expect(o.hoursAppliedMessage({ lines: 1, hours: 2.5 })).toBe("2.50h billed on 1 line.");
    expect(o.hoursAppliedMessage({ lines: 3, hours: 10 })).toBe("10.00h billed on 3 lines.");
  });

  it("names the cached PDF by kind and number", () => {
    expect(o.pdfFileName("invoice", 1042)).toBe("invoice-1042.pdf");
    expect(o.pdfFileName("quote", "Q/7")).toBe("quote-Q7.pdf");
  });
});

describe("the mirrored rules the screens use", () => {
  const p = require("./invoicePayments") as typeof import("./invoicePayments");
  const pi = require("./poInvoice") as typeof import("./poInvoice");

  it("offers Record payment only for a sent invoice with money owing, not in Xero", () => {
    const inv = { status: "sent", xero_invoice_id: null, total: 110, amount_paid: 10 };
    expect(p.canRecordPayment(inv)).toBe(true);
    expect(p.canRecordPayment({ ...inv, status: "draft" })).toBe(false);
    expect(p.canRecordPayment({ ...inv, xero_invoice_id: "x" })).toBe(false);
    expect(p.canRecordPayment({ ...inv, amount_paid: 110 })).toBe(false);
  });

  it("shows the PO picker only for a job with more than one priced PO", () => {
    const pos = [
      { id: "a", po_number: "S-1", total_value: 5000 },
      { id: "b", po_number: "SW-2", total_value: 0 },
      { id: "c", po_number: "SW-3", total_value: "2500" },
    ];
    const priced = pi.pricedPos(pos);
    expect(priced.map((x) => x.id)).toEqual(["a", "c"]);
    expect(pi.claimBuilderPo(priced, pi.poForCustomerPo(priced, " SW-3 "))).toEqual({ poNumber: "SW-3", value: 2500 });
    expect(pi.claimBuilderPo([pos[0]], pos[0])).toBeNull();
  });
});
