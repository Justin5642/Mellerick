import { describe, it, expect } from "vitest";
import {
  dayWorksItems,
  filterAndSortUnbilled,
  groupUnbilled,
  hoursItem,
  invoiceHref,
  isHoursCandidate,
  loadItems,
  parseUnbilledFilters,
  poItems,
  unbilledCsv,
  unbilledCustomers,
  unbilledDigest,
  unbilledTotals,
  variationAmount,
  variationItems,
  type UnbilledHireEntry,
  type UnbilledItem,
  type UnbilledJobInfo,
  type UnbilledLoad,
  type UnbilledVariationRow,
} from "@/lib/unbilled-work";
import type { HireOption } from "@/lib/hire-pricing";
import type { HoursEntry } from "@/lib/approved-hours";
import { buildDigest, unbilledLine } from "@/lib/weekly-digest";

const JOB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB_QA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CUST_1 = "11111111-1111-4111-8111-111111111111";
const CUST_2 = "22222222-2222-4222-8222-222222222222";

const options: (HireOption & { is_active?: boolean | null })[] = [
  { equipment_id: "ex1", hire_type: "wet", hire_unit: "hour", rate: 150 },
  { equipment_id: "truck", hire_type: "cartage", hire_unit: "tonne", rate: 10, is_active: true },
  { equipment_id: "truck", hire_type: "cartage", hire_unit: "km", rate: 2, is_active: true },
];
const entry = (over: Partial<UnbilledHireEntry> = {}): UnbilledHireEntry => ({
  id: "e1",
  job_id: JOB_A,
  equipment_id: "ex1",
  hire_type: "wet",
  hire_unit: "hour",
  work_date: "2026-11-10",
  hours: 8,
  status: "signed",
  invoice_id: null,
  attachment_ids: [],
  ...over,
});

describe("Day Works", () => {
  const names = new Map([["ex1", "PC88"]]);
  it("prices signed, un-invoiced lines at today's rates, attachments a full day", () => {
    const items = dayWorksItems([entry({ attachment_ids: ["t"] })], options, [{ id: "t", name: "Trencher", day_rate: 200 }], names);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "dayworks", amount: 1400, problem: null, date: "2026-11-10" });
    expect(items[0].label.startsWith("PC88 — ")).toBe(true);
    expect(items[0].detail).toContain("Trencher");
  });
  it("leaves out drafts, void and invoiced lines", () => {
    expect(dayWorksItems([entry({ status: "draft" }), entry({ status: "invoiced" }), entry({ status: "void" }), entry({ invoice_id: "inv" })], options, [], names)).toEqual([]);
  });
  it("a machine with no hire setup is not priced — never $0", () => {
    const [it0] = dayWorksItems([entry({ equipment_id: "nope" })], options, [], names);
    expect(it0.amount).toBeNull();
    expect(it0.problem).toMatch(/Hire setup/);
  });
});

describe("Truck loads", () => {
  const load = (over: Partial<UnbilledLoad> = {}): UnbilledLoad => ({
    id: "l1",
    job_id: JOB_A,
    equipment_id: "truck",
    load_date: "2026-11-12",
    direction: "spoil_out",
    billing: "extra",
    quantity: 12,
    unit: "tonne",
    km: 20,
    status: "signed",
    invoice_id: null,
    place: "Wollert tip",
    ...over,
  });
  const names = new Map([["truck", "Isuzu"]]);
  it("prices a signed extra like Invoice Day Works: cartage + tip fee × margin + km", () => {
    const [it0] = loadItems([load()], options, new Map([["l1", { docket_cost_ex_gst: 100, margin_pct: null }]]), 15, names);
    expect(it0).toMatchObject({ kind: "load", amount: 275, problem: null, label: "Spoil removal 12 t" });
  });
  it("says why an extra can't be priced (no docket cost)", () => {
    const [it0] = loadItems([load()], options, new Map(), 15, names);
    expect(it0.amount).toBeNull();
    expect(it0.problem).toMatch(/tip fee/);
  });
  it("leaves out included, drafts and invoiced loads", () => {
    expect(loadItems([load({ billing: "included" }), load({ status: "draft" }), load({ status: "invoiced" }), load({ invoice_id: "x" })], options, new Map(), 15, names)).toEqual([]);
  });
});

describe("Variations", () => {
  const v = (over: Partial<UnbilledVariationRow> = {}): UnbilledVariationRow => ({
    id: "v1",
    job_id: JOB_A,
    status: "approved",
    invoice_id: null,
    custom_name: "Hit rock",
    quantity: 4,
    unit: "h",
    rate: 120,
    total_amount: null,
    approved_at: "2026-11-05T03:00:00Z",
    logged_at: null,
    variation_types: null,
    ...over,
  });
  const titles = new Map([
    [JOB_A, "Lot 4"],
    [JOB_QA, "QA FIXTURE — do not invoice, do not delete"],
  ]);
  it("worth total_amount, else rate × quantity, else not priced", () => {
    expect(variationAmount({ total_amount: 500, rate: 1, quantity: 1 })).toBe(500);
    expect(variationAmount({ total_amount: null, rate: 120, quantity: 4 })).toBe(480);
    expect(variationAmount({ total_amount: null, rate: null, quantity: 4 })).toBeNull();
  });
  it("approved / auto-approved with no invoice; the QA fixture job left out", () => {
    const items = variationItems(
      [v(), v({ id: "v2", status: "auto_approved", total_amount: 90 }), v({ id: "v3", status: "pending_approval" }), v({ id: "v4", invoice_id: "i" }), v({ id: "v5", job_id: JOB_QA })],
      titles
    );
    expect(items.map((i) => [i.id, i.amount])).toEqual([
      ["v1", 480],
      ["v2", 90],
    ]);
    expect(items[0].date).toBe("2026-11-05");
  });
});

describe("Hours", () => {
  const e = (over: Partial<HoursEntry> = {}): HoursEntry => ({
    id: "t1",
    staff_id: "s1",
    staff_name: "Brodie",
    cost_center_id: null,
    cost_center_name: "Sewer",
    entry_type: "work",
    clock_in: "2026-11-03T21:00:00Z",
    clock_out: "2026-11-04T05:00:00Z",
    invoice_id: null,
    ...over,
  });
  it("counts hours not on an invoice, never priced", () => {
    const it0 = hoursItem(JOB_A, [e(), e({ id: "t2", invoice_id: "inv" }), e({ id: "t3", labour_line: true })]) as UnbilledItem;
    expect(it0).toMatchObject({ kind: "hours", hours: 8, amount: null, problem: null, date: "2026-11-04" });
    expect(hoursItem(JOB_A, [e({ invoice_id: "x" })])).toBeNull();
  });
  it("asks only finished jobs: ready to invoice, or completed and not invoiced before hours reached invoices", () => {
    const job = { id: JOB_A, status: "completed", admin_status: "pending", ready_to_invoice: false };
    expect(isHoursCandidate(job, [])).toBe(true);
    expect(isHoursCandidate({ ...job, admin_status: "approved" }, [])).toBe(false);
    expect(isHoursCandidate(job, [{ status: "sent", created_at: "2026-10-01T00:00:00Z" }])).toBe(false);
    expect(isHoursCandidate(job, [{ status: "draft", created_at: "2026-11-20T00:00:00Z" }])).toBe(true);
    expect(isHoursCandidate(job, [{ status: "cancelled", created_at: "2026-10-01T00:00:00Z" }])).toBe(true);
    expect(isHoursCandidate({ ...job, status: "in_progress", ready_to_invoice: true }, [])).toBe(true);
    expect(isHoursCandidate({ ...job, status: "in_progress" }, [])).toBe(false);
    expect(isHoursCandidate({ ...job, status: "cancelled", ready_to_invoice: true }, [])).toBe(false);
  });
});

describe("Builder POs", () => {
  const jobs = new Map([
    [JOB_A, { status: "completed", actual_end: "2026-11-01T02:00:00Z", title: "Lot 4" }],
    [JOB_B, { status: "in_progress", actual_end: null, title: "Lot 5" }],
  ]);
  const pos = [
    { id: "p1", job_id: JOB_A, po_number: "B-100", total_value: 10000, created_at: null },
    { id: "p2", job_id: JOB_A, po_number: "B-200", total_value: 5000, created_at: null },
    { id: "p3", job_id: JOB_A, po_number: "B-300", total_value: 2000, created_at: null },
    { id: "p4", job_id: JOB_A, po_number: "SIMPRO-9", total_value: 2000, created_at: null },
    { id: "p5", job_id: JOB_A, po_number: "B-0", total_value: 0, created_at: null },
    { id: "p6", job_id: JOB_B, po_number: "B-600", total_value: 900, created_at: null },
  ];
  const inv = (customer_po: string, subtotal: number, status = "sent") => ({ id: customer_po + subtotal, invoice_number: 7, subtotal, status, customer_po });
  it("completed jobs only: none → the value, part → what's left, full → left out", () => {
    const items = poItems(pos, new Map([[JOB_A, [inv("b-100", 4000), inv("B-200", 5000), inv("B-300", 2000, "cancelled")]]]), jobs);
    expect(items.map((i) => [i.label, i.amount])).toEqual([
      ["PO B-100", 6000],
      ["PO B-300", 2000],
    ]);
    expect(items[0].detail).toContain("$4,000.00 of $10,000.00 invoiced");
    expect(items[0].date).toBe("2026-11-01");
  });
});

describe("grouping, totals, filters, sorting, CSV", () => {
  const info = (id: string, n: number, title: string, customer_id: string, company: string | null): UnbilledJobInfo => ({
    id,
    job_number: n,
    title,
    status: "completed",
    customer_id,
    customers: { name: "Simon", company },
  });
  const jobs = new Map([
    [JOB_A, info(JOB_A, 101, "Lot 4", CUST_1, "Luxton Homes")],
    [JOB_B, info(JOB_B, 102, "Lot 5", CUST_2, null)],
    [JOB_QA, info(JOB_QA, 834, "QA FIXTURE — do not invoice", CUST_2, null)],
  ]);
  const item = (over: Partial<UnbilledItem>): UnbilledItem => ({ kind: "dayworks", id: "x", jobId: JOB_A, date: "2026-11-10", label: "L", detail: "", amount: 100, problem: null, ...over });
  const items: UnbilledItem[] = [
    item({ id: "a1", amount: 100, date: "2026-11-20" }),
    item({ id: "a2", kind: "load", amount: null, problem: "Enter the tip fee", date: "2026-11-01" }),
    item({ id: JOB_A, kind: "hours", amount: null, hours: 5.5, date: "2026-11-15" }),
    item({ id: "b1", jobId: JOB_B, kind: "po", amount: 5000, date: "2026-11-25" }),
    item({ id: "q1", jobId: JOB_QA, kind: "variation", amount: 999 }),
  ];
  const today = "2026-11-28";
  const grouped = groupUnbilled(items, jobs, today);

  it("groups by job with billed name, totals only priced items, QA job left out", () => {
    expect(grouped.map((j) => j.jobNumber).sort()).toEqual([101, 102]);
    const a = grouped.find((j) => j.jobId === JOB_A)!;
    expect(a).toMatchObject({ customer: "Luxton Homes", total: 100, unpriced: 1, hours: 5.5, oldestDate: "2026-11-01", ageDays: 27 });
    expect(a.items.map((i) => i.kind)).toEqual(["dayworks", "load", "hours"]);
    expect(grouped.find((j) => j.jobId === JOB_B)!.customer).toBe("Simon");
  });
  it("grand totals and per-section totals", () => {
    const t = unbilledTotals(grouped);
    expect(t).toMatchObject({ total: 5100, jobs: 2, items: 4, unpriced: 1, hours: 5.5, oldestDays: 27 });
    expect(t.byKind.po).toEqual({ items: 1, total: 5000, unpriced: 0, hours: 0 });
    expect(t.byKind.load.unpriced).toBe(1);
    expect(unbilledDigest(grouped)).toEqual({ total: 5100, jobs: 2, oldestDays: 27, hours: 5.5, unpriced: 1 });
  });
  it("sorts oldest first by default, or biggest value", () => {
    expect(filterAndSortUnbilled(grouped, parseUnbilledFilters({})).map((j) => j.jobNumber)).toEqual([101, 102]);
    expect(filterAndSortUnbilled(grouped, parseUnbilledFilters({ sort: "value" })).map((j) => j.jobNumber)).toEqual([102, 101]);
  });
  it("filters by customer and by age", () => {
    expect(filterAndSortUnbilled(grouped, parseUnbilledFilters({ customer: CUST_2 })).map((j) => j.jobNumber)).toEqual([102]);
    expect(filterAndSortUnbilled(grouped, parseUnbilledFilters({ older: "10" })).map((j) => j.jobNumber)).toEqual([101]);
    expect(parseUnbilledFilters({ customer: "nope", older: "x", sort: "weird" })).toEqual({ customerId: null, olderThanDays: null, sort: "oldest" });
    expect(unbilledCustomers(grouped)).toEqual([
      { id: CUST_1, name: "Luxton Homes" },
      { id: CUST_2, name: "Simon" },
    ]);
  });
  it("CSV: one row per item, formulas defused", () => {
    const csv = unbilledCsv(grouped, today).trim().split("\r\n");
    expect(csv[0]).toBe("Job,Title,Customer,Job status,Kind,Date,Days old,Item,Detail,Amount ex GST,Hours,Not priced because");
    expect(csv).toHaveLength(5);
    expect(csv.some((l) => l.includes("Enter the tip fee"))).toBe(true);
    const odd = groupUnbilled([item({ label: "=SUM(A1)" })], jobs, today);
    expect(unbilledCsv(odd, today)).toContain("'=SUM(A1)");
  });
  it("links each kind to where it is invoiced", () => {
    expect(invoiceHref("dayworks", JOB_A, "x")).toBe(`/dashboard/jobs/${JOB_A}?tab=dayworks`);
    expect(invoiceHref("load", JOB_A, "x")).toBe(`/dashboard/jobs/${JOB_A}?tab=dayworks`);
    expect(invoiceHref("variation", JOB_A, "x")).toBe(`/dashboard/jobs/${JOB_A}?tab=variations`);
    expect(invoiceHref("po", JOB_A, "p1")).toBe(`/dashboard/invoices/new?job_id=${JOB_A}&po_id=p1`);
    expect(invoiceHref("hours", JOB_A, JOB_A)).toBe(`/dashboard/invoices/new?job_id=${JOB_A}`);
  });
});

describe("Monday email line", () => {
  const base = {
    appUrl: "https://app.test",
    unallocated: { count: 0, total: 0, bills: [] },
    coverage: [],
    overdue: { count: 0, total: 0, top: [] },
    awaitingInvoice: { count: 0, oldest: [] },
  } as unknown as Parameters<typeof buildDigest>[0];
  it("says $X across N jobs (oldest D days) and links to the page; left out when unknown", () => {
    const u = { total: 12345.6, jobs: 3, oldestDays: 41, hours: 0 };
    expect(unbilledLine(u)).toBe("Unbilled work: $12,346 across 3 jobs (oldest 41 days)");
    const d = buildDigest({ ...base, unbilled: u });
    expect(d.text).toContain("Unbilled work: $12,346 across 3 jobs (oldest 41 days)");
    expect(d.text).toContain("https://app.test/dashboard/reports/unbilled");
    expect(d.html).toContain("https://app.test/dashboard/reports/unbilled");
    expect(buildDigest({ ...base, unbilled: null }).text).not.toContain("Unbilled work");
    expect(unbilledLine({ total: 0, jobs: 0, oldestDays: null, hours: 0 })).toBe("Unbilled work: nothing waiting to be invoiced");
  });
});
