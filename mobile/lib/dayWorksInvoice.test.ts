import { invoiceChoice, invoiceProblem, lastMonth, lastWeek } from "./dayWorksInvoice";

// Invoice Day Works on the phone (office/admin): the same period choices and
// selection as the web tab. Amounts come from the server's office answer only.

const entry = (id: string, work_date: string, status = "signed", invoice_id: string | null = null) =>
  ({ id, work_date, status, invoice_id, equipment: "PC88" }) as never;
const load = (id: string, load_date: string, billing = "extra", status = "signed") => ({ id, load_date, billing, status, invoice_id: null, truck: "Tipper" }) as never;

describe("periods", () => {
  it("last week is Monday to Sunday before this week", () => {
    expect(lastWeek("2026-11-19")).toEqual({ from: "2026-11-09", to: "2026-11-15" }); // Thursday
    expect(lastWeek("2026-11-22")).toEqual({ from: "2026-11-09", to: "2026-11-15" }); // Sunday
    expect(lastWeek("2026-11-23")).toEqual({ from: "2026-11-16", to: "2026-11-22" }); // Monday
  });
  it("last month is the whole previous calendar month, across a year end", () => {
    expect(lastMonth("2026-11-19")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(lastMonth("2027-01-05")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
});

describe("choice", () => {
  const base = {
    entries: [entry("e1", "2026-11-10"), entry("e2", "2026-11-12"), entry("e-draft", "2026-11-11", "draft"), entry("e-inv", "2026-11-11", "signed", "inv-1"), entry("e-old", "2026-10-02")],
    entryPricing: { entries: { e1: { total: 500 }, e2: { total: null }, "e-old": { total: 100 } }, byCostCentre: [], uninvoicedSigned: 0 },
    loads: [load("l1", "2026-11-11"), load("l-inc", "2026-11-11", "included"), load("l-draft", "2026-11-11", "extra", "draft")],
    loadPricing: {
      companyMarginPct: 15,
      uninvoicedSigned: 0,
      loads: { l1: { total: 250.5, docketCost: 200, marginOverride: null, marginPct: 15, docketPhotoUrl: null, lines: [], problem: null } },
    },
    period: { from: "2026-11-09", to: "2026-11-15" },
    excluded: new Set<string>(),
    entryLabel: (e: { equipment: string }) => e.equipment,
    loadLabel: (l: { truck: string }) => l.truck,
  };

  it("lists signed, un-invoiced lines and signed EXTRA loads in the period, by date", () => {
    const c = invoiceChoice(base as never);
    expect(c.lines.map((l) => l.id)).toEqual(["e1", "l1", "e2"]);
    expect(c.waitingCount).toBe(4);
    expect(c.allWaiting).toEqual({ from: "2026-10-02", to: "2026-11-12" });
    expect(c.unpriced).toBe(1);
    expect(c.total).toBe(750.5);
    expect(invoiceProblem(c)).toMatch(/1 ticked line can't be priced/);
  });

  it("unticking the unpriced line clears the problem; nothing ticked is its own problem", () => {
    const c = invoiceChoice({ ...base, excluded: new Set(["e2"]) } as never);
    expect(c.picked.map((l) => l.id)).toEqual(["e1", "l1"]);
    expect(invoiceProblem(c)).toBeNull();
    const none = invoiceChoice({ ...base, excluded: new Set(["e1", "e2", "l1"]) } as never);
    expect(invoiceProblem(none)).toBe("Tick at least one line.");
  });

  it("without the office's pricing nothing is priced (never $0)", () => {
    const c = invoiceChoice({ ...base, entryPricing: undefined, loadPricing: undefined } as never);
    expect(c.lines.every((l) => l.amount === null)).toBe(true);
    expect(invoiceProblem(c)).toMatch(/can't be priced/);
  });
});
