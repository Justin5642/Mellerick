const mockGetSession = jest.fn();
const mockFetch = jest.fn();
jest.mock("./supabase", () => ({ supabase: { auth: { getSession: (...a: unknown[]) => mockGetSession(...a) }, storage: { from: jest.fn() } } }));
jest.mock("./fetchWithTimeout", () => ({ fetchWithTimeout: (...a: unknown[]) => mockFetch(...a) }));

// The module reads the server address when it loads, so set it first.
process.env.EXPO_PUBLIC_API_BASE_URL = "https://office.test";
const po = require("./jobPurchaseOrders") as typeof import("./jobPurchaseOrders");
const {
  DOCUMENTS_OFFLINE,
  PO_TAB_OFFLINE,
  addJobPo,
  documentPhotoName,
  gstOf,
  isOfflineError,
  loadJobPurchaseOrders,
  ordersByLine,
  poSplitState,
  supplierInvoiceProblem,
  uploadJobDocument,
} = po;
type PoSupplierOrder = import("./jobPurchaseOrders").PoSupplierOrder;
import { poInvoiceLines } from "./poInvoice";

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: { access_token: "tok" } } });
});

describe("calls to the office server", () => {
  it("send the caller's token and the client id for a new PO", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ pos: [] }) });
    await addJobPo("job-1", "po-1", { poNumber: "4321-1", clientReference: "", siteAddress: "", value: "100", lines: [] });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://office.test/api/jobs/job-1/purchase-orders");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toMatchObject({ id: "po-1", poNumber: "4321-1", value: "100" });
  });

  it("say 'needs signal' when there is no connection — the tab's and the documents' own words", async () => {
    mockFetch.mockRejectedValue(new TypeError("Network request failed"));
    const err = await loadJobPurchaseOrders("job-1").catch((e: Error) => e);
    expect(isOfflineError(err)).toBe(true);
    expect((err as Error).message).toContain(PO_TAB_OFFLINE);
    const doc = await uploadJobDocument("job-1", { file: "x", fileName: "a.jpg", officeOnly: false }).catch((e: Error) => e);
    expect((doc as Error).message).toContain(DOCUMENTS_OFFLINE);
    // A photo goes up in the request: a longer wait than the 30 s default.
    expect(mockFetch.mock.calls[1][2]).toBe(60_000);
  });

  it("surface the server's own sentence", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "Enter the PO number." }) });
    await expect(loadJobPurchaseOrders("job-1")).rejects.toThrow("Enter the PO number.");
  });
});

describe("poSplitState — the PO card's 'not split yet' / 'over'", () => {
  const line = (allocated_amount: number) => ({ id: "l", name: "x", cost_centre_id: null, allocated_amount, allocated_hours: 0, sort_order: 0, completed_at: null });
  it("split when the lines add up, to the cent", () => {
    expect(poSplitState({ total_value: 0.3, lines: [line(0.1), line(0.2)] })).toEqual({ kind: "split", amount: 0 });
  });
  it("names what's left and what's over", () => {
    expect(poSplitState({ total_value: 1000, lines: [line(600)] })).toEqual({ kind: "unsplit", amount: 400 });
    expect(poSplitState({ total_value: 1000, lines: [line(1200.5)] })).toEqual({ kind: "over", amount: 200.5 });
  });
});

describe("supplier invoice form", () => {
  it("needs the number and an amount above zero; the date is optional but must be a date", () => {
    expect(supplierInvoiceProblem({ invoiceNumber: " ", amount: "10", invoiceDate: null })).toMatch(/invoice number/);
    expect(supplierInvoiceProblem({ invoiceNumber: "A1", amount: "0", invoiceDate: null })).toMatch(/amount/);
    expect(supplierInvoiceProblem({ invoiceNumber: "A1", amount: "1,250.00", invoiceDate: "18/11/2026" })).toMatch(/YYYY-MM-DD/);
    expect(supplierInvoiceProblem({ invoiceNumber: "A1", amount: "$1,250.00", invoiceDate: "2026-11-18" })).toBeNull();
  });
  it("GST is 10% to the cent", () => {
    expect(gstOf("1,234.55")).toBe(123.46);
    expect(gstOf("")).toBeNull();
  });
});

describe("ordersByLine", () => {
  it("groups the supplier orders under their PO line", () => {
    const o = (id: string, line: string) => ({ id, cost_center_id: line }) as PoSupplierOrder;
    expect(ordersByLine([o("1", "a"), o("2", "b"), o("3", "a")])).toEqual({ a: [o("1", "a"), o("3", "a")], b: [o("2", "b")] });
  });
});

describe("Invoice this PO", () => {
  it("uses the PO's priced lines when they add up, else one line for the value", () => {
    const po = { po_number: "4321-1", total_value: 1000, lines: [{ name: "Drainage", allocated_amount: 800, sort_order: 0 }, { name: "Transport", allocated_amount: 200, sort_order: 1 }] };
    expect(poInvoiceLines(po).map((l) => [l.name, l.unit_price])).toEqual([["Drainage", "800.00"], ["Transport", "200.00"]]);
    expect(poInvoiceLines({ ...po, total_value: 1500 })).toEqual([{ name: "PO 4321-1", description: "", quantity: "1", unit_price: "1500.00" }]);
  });
});

describe("documentPhotoName", () => {
  it("keeps what the office typed, safely, as a .jpg", () => {
    expect(documentPhotoName(" Plan sheet 2 / rev B ")).toBe("Plan sheet 2  rev B.jpg");
  });
  it("names an unnamed photo by the Melbourne date", () => {
    expect(documentPhotoName("", new Date("2026-11-18T20:00:00Z"))).toBe("Photo 19 Nov 2026.jpg");
  });
});
