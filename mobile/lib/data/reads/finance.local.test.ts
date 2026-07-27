// London-school tests for the finance read module's local (PowerSync SQLite)
// path. A fake LocalReads is injected through the seam; it is fed
// SQLite-shaped rows (numbers for numerics per the column.real cast — plus the
// odd string to prove coercion — integers for booleans, null FKs) and we
// assert the mapped output equals the PostgREST-shaped interfaces, plus the
// exact SQL (normalized whitespace) and params the fake received.
//
// The module imports the supabase client (native AsyncStorage chain); stub it
// with a chainable thenable so remote bodies resolve { data: null } harmlessly.
jest.mock("../../supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "in", "is", "order", "range", "single"]) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = (
    onFulfilled: (v: { data: null }) => unknown,
    onRejected?: (e: unknown) => unknown
  ) => Promise.resolve({ data: null }).then(onFulfilled, onRejected);
  return { supabase: chain };
});

import { supabase } from "../../supabase";
import { resetSourceForTests, setLocalReads, type LocalReads, type LocalRole } from "./source";
import {
  getInvoice,
  getInvoiceJobPrefill,
  getQuote,
  listInactivePricing,
  listInvoices,
  listPricing,
  listQuotes,
  listReadyToInvoice,
  SQL_GET_INVOICE,
  SQL_GET_INVOICE_ITEMS,
  SQL_GET_QUOTE,
  SQL_GET_QUOTE_ITEMS,
  SQL_LIST_INVOICES,
  SQL_LIST_QUOTES,
  SQL_PREFILL_JOB,
  SQL_PREFILL_JOB_ITEMS,
  SQL_PREFILL_VARIATIONS,
  SQL_PRICING,
  SQL_READY_JOBS,
  SQL_READY_VARIATIONS,
} from "./finance";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Fake LocalReads: getAll/getOptional dispatch on the exact SQL const passed. */
function fakeReads(data: Map<string, unknown>, role: LocalRole = "office"): LocalReads {
  return {
    hasSynced: () => true,
    role: () => role,
    getAll: jest.fn(async (sql: string) => (data.get(sql) as unknown[]) ?? []) as unknown as LocalReads["getAll"],
    getOptional: jest.fn(async (sql: string) => data.get(sql) ?? null) as unknown as LocalReads["getOptional"],
  };
}

afterEach(() => {
  resetSourceForTests();
  jest.clearAllMocks();
});

describe("listInvoices (local)", () => {
  it("maps SQLite rows to the PostgREST shape, null customer FK included", async () => {
    const fake = fakeReads(
      new Map([
        [
          SQL_LIST_INVOICES,
          [
            // string numeric proves the mapper coerces even if a cast regresses
            { id: "i1", invoice_number: 1042, title: "Backflow annual", total: "1234.50", status: "sent", due_date: "2026-08-01", customer_name: "Acme Water" },
            { id: "i2", invoice_number: 1041, title: "Walk-in", total: null, status: "draft", due_date: null, customer_name: null },
          ],
        ],
      ])
    );
    setLocalReads(fake);

    await expect(listInvoices(40, 20)).resolves.toEqual([
      { id: "i1", invoice_number: 1042, title: "Backflow annual", total: 1234.5, status: "sent", due_date: "2026-08-01", customers: { name: "Acme Water" } },
      { id: "i2", invoice_number: 1041, title: "Walk-in", total: null, status: "draft", due_date: null, customers: null },
    ]);

    const [sql, params] = (fake.getAll as jest.Mock).mock.calls[0];
    expect(norm(sql)).toBe(
      "SELECT i.id, i.invoice_number, i.title, i.total, i.status, i.due_date, c.name AS customer_name " +
        "FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id " +
        "ORDER BY i.created_at DESC, i.id DESC LIMIT ? OFFSET ?"
    );
    expect(params).toEqual([20, 40]); // LIMIT ?, OFFSET ? — limit first
  });
});

describe("getInvoice (local)", () => {
  it("computes line totals via ROUND(quantity * unit_price, 2) — the generated column does not replicate", () => {
    // The trap in one assertion: the items SQL must compute total, never select it bare.
    expect(norm(SQL_GET_INVOICE_ITEMS)).toBe(
      "SELECT id, name, description, quantity, unit_price, ROUND(quantity * unit_price, 2) AS total " +
        "FROM invoice_items WHERE invoice_id = ? ORDER BY created_at, id"
    );
    expect(norm(SQL_GET_QUOTE_ITEMS)).toBe(
      "SELECT id, name, description, quantity, unit_price, ROUND(quantity * unit_price, 2) AS total " +
        "FROM quote_items WHERE quote_id = ? ORDER BY created_at, id"
    );
  });

  it("nests the customer and maps items; the computed total flows to the output", async () => {
    const fake = fakeReads(
      new Map<string, unknown>([
        [
          SQL_GET_INVOICE,
          { id: "inv1", invoice_number: 7, title: "Reline stage 2", status: "sent", subtotal: "100.50", tax_amount: 10.05, total: 110.55, due_date: null, created_at: "2026-07-01T00:00:00Z", notes: null, work_description: "CIPP reline", xero_invoice_id: null, customer_name: "Acme", customer_email: null, customer_phone: "03 9123 4567" },
        ],
        // row shaped as the SQL produces it: total is the ROUND() alias, not the (NULL) generated column
        [SQL_GET_INVOICE_ITEMS, [{ id: "li1", name: "Valve", description: null, quantity: 3, unit_price: 33.5, total: 100.5 }]],
      ])
    );
    setLocalReads(fake);

    await expect(getInvoice("inv1")).resolves.toEqual({
      id: "inv1",
      invoice_number: 7,
      title: "Reline stage 2",
      status: "sent",
      subtotal: 100.5,
      tax_amount: 10.05,
      total: 110.55,
      due_date: null,
      created_at: "2026-07-01T00:00:00Z",
      notes: null,
      work_description: "CIPP reline",
      xero_invoice_id: null,
      customers: { name: "Acme", email: null, phone: "03 9123 4567" },
      invoice_items: [{ id: "li1", name: "Valve", description: null, quantity: 3, unit_price: 33.5, total: 100.5 }],
    });

    expect(fake.getOptional).toHaveBeenCalledWith(SQL_GET_INVOICE, ["inv1"]);
    expect(fake.getAll).toHaveBeenCalledWith(SQL_GET_INVOICE_ITEMS, ["inv1"]);
  });

  it("returns null for a missing invoice without running the items query", async () => {
    const fake = fakeReads(new Map());
    setLocalReads(fake);
    await expect(getInvoice("nope")).resolves.toBeNull();
    expect(fake.getAll).not.toHaveBeenCalled();
  });
});

describe("listReadyToInvoice (local)", () => {
  it("filters ready_to_invoice = 1 (integer boolean) and rebuilds both embeds", async () => {
    const fake = fakeReads(
      new Map<string, unknown>([
        [SQL_READY_JOBS, [{ id: "j1", job_number: 101, title: "Reline", customer_name: "Acme" }]],
        [
          SQL_READY_VARIATIONS,
          [
            { id: "v1", total_amount: "450.00", job_id: "j1", job_number: 101, job_title: "Reline", customer_name: "Acme" },
            // orphaned variation: null job FK must yield jobs: null, not {id: null, …}
            { id: "v2", total_amount: null, job_id: null, job_number: null, job_title: null, customer_name: null },
          ],
        ],
      ])
    );
    setLocalReads(fake);

    await expect(listReadyToInvoice()).resolves.toEqual({
      jobs: [{ id: "j1", job_number: 101, title: "Reline", customers: { name: "Acme" } }],
      variations: [
        { id: "v1", total_amount: 450, jobs: { id: "j1", job_number: 101, title: "Reline", customers: { name: "Acme" } } },
        { id: "v2", total_amount: null, jobs: null },
      ],
    });

    const sqls = (fake.getAll as jest.Mock).mock.calls.map((c: unknown[]) => norm(c[0] as string));
    expect(sqls).toContain(
      "SELECT j.id, j.job_number, j.title, c.name AS customer_name " +
        "FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id " +
        "WHERE j.ready_to_invoice = 1 ORDER BY j.updated_at DESC"
    );
    expect(sqls).toContain(
      "SELECT v.id, v.total_amount, j.id AS job_id, j.job_number, j.title AS job_title, c.name AS customer_name " +
        "FROM job_variations v LEFT JOIN jobs j ON j.id = v.job_id LEFT JOIN customers c ON c.id = j.customer_id " +
        "WHERE v.status IN ('approved','auto_approved') AND v.invoice_id IS NULL"
    );
  });
});

describe("getInvoiceJobPrefill (local)", () => {
  it("maps items and variations, falling back through completion notes → transcript and type name → custom name", async () => {
    const fake = fakeReads(
      new Map<string, unknown>([
        [SQL_PREFILL_JOB, { customer_id: "c1", title: "Pit repair", completion_notes: "", voice_report_transcript: "Spoken report", customer_name: "Acme" }],
        [SQL_PREFILL_JOB_ITEMS, [{ name: "Pipe", description: null, quantity: 2, unit_price: "10.25" }]],
        [
          SQL_PREFILL_VARIATIONS,
          [
            // no total_amount → rate × quantity; named by its variation type
            { id: "v1", custom_name: null, quantity: 3, unit: "hr", rate: 100, total_amount: null, variation_type_name: "Extra excavation" },
            // total_amount wins; no type → custom name; no unit/rate → bare quantity description
            { id: "v2", custom_name: "Custom thing", quantity: 1, unit: null, rate: null, total_amount: 55, variation_type_name: null },
          ],
        ],
      ])
    );
    setLocalReads(fake);

    await expect(getInvoiceJobPrefill("job1")).resolves.toEqual({
      customerId: "c1",
      customerName: "Acme",
      title: "Pit repair",
      workDescription: "Spoken report",
      items: [{ name: "Pipe", description: null, quantity: 2, unitPrice: 10.25 }],
      unbilledVariations: [
        { id: "v1", name: "Extra excavation", description: "3 hr @ $100.00", unitPrice: 300 },
        { id: "v2", name: "Custom thing", description: "1", unitPrice: 55 },
      ],
    });

    expect(fake.getOptional).toHaveBeenCalledWith(SQL_PREFILL_JOB, ["job1"]);
    expect(fake.getAll).toHaveBeenCalledWith(SQL_PREFILL_JOB_ITEMS, ["job1"]);
    expect(fake.getAll).toHaveBeenCalledWith(SQL_PREFILL_VARIATIONS, ["job1"]);
    // job_items are selected without total — the generated column never appears
    expect(norm(SQL_PREFILL_JOB_ITEMS)).toBe(
      "SELECT name, description, quantity, unit_price FROM job_items WHERE job_id = ? ORDER BY created_at, id"
    );
  });

  it("returns null when the job does not exist", async () => {
    setLocalReads(fakeReads(new Map()));
    await expect(getInvoiceJobPrefill("nope")).resolves.toBeNull();
  });
});

describe("listQuotes / getQuote (local)", () => {
  it("maps quote list rows with LIMIT/OFFSET", async () => {
    const fake = fakeReads(
      new Map([
        [SQL_LIST_QUOTES, [{ id: "q1", quote_number: 12, title: "CCTV survey", total: 990, status: "draft", valid_until: null, customer_name: null }]],
      ])
    );
    setLocalReads(fake);

    await expect(listQuotes(0, 25)).resolves.toEqual([
      { id: "q1", quote_number: 12, title: "CCTV survey", total: 990, status: "draft", valid_until: null, customers: null },
    ]);

    const [sql, params] = (fake.getAll as jest.Mock).mock.calls[0];
    expect(norm(sql)).toBe(
      "SELECT q.id, q.quote_number, q.title, q.total, q.status, q.valid_until, c.name AS customer_name " +
        "FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id " +
        "ORDER BY q.created_at DESC, q.id DESC LIMIT ? OFFSET ?"
    );
    expect(params).toEqual([25, 0]);
  });

  it("maps the quote detail incl. customer_id/site_id/job_id passthrough and computed item totals", async () => {
    const fake = fakeReads(
      new Map<string, unknown>([
        [
          SQL_GET_QUOTE,
          { id: "q1", quote_number: 12, title: "CCTV survey", status: "sent", subtotal: 900, tax_amount: 90, total: 990, valid_until: "2026-09-30", created_at: "2026-07-10T00:00:00Z", notes: null, customer_id: "c1", site_id: null, job_id: null, customer_name: "Acme", customer_email: "ap@acme.com", customer_phone: null },
        ],
        [SQL_GET_QUOTE_ITEMS, [{ id: "qi1", name: "Survey", description: "100m", quantity: "1", unit_price: "900", total: "900" }]],
      ])
    );
    setLocalReads(fake);

    await expect(getQuote("q1")).resolves.toEqual({
      id: "q1",
      quote_number: 12,
      title: "CCTV survey",
      status: "sent",
      subtotal: 900,
      tax_amount: 90,
      total: 990,
      valid_until: "2026-09-30",
      created_at: "2026-07-10T00:00:00Z",
      notes: null,
      customer_id: "c1",
      site_id: null,
      job_id: null,
      customers: { name: "Acme", email: "ap@acme.com", phone: null },
      quote_items: [{ id: "qi1", name: "Survey", description: "100m", quantity: 1, unit_price: 900, total: 900 }],
    });
    expect(fake.getOptional).toHaveBeenCalledWith(SQL_GET_QUOTE, ["q1"]);
    expect(fake.getAll).toHaveBeenCalledWith(SQL_GET_QUOTE_ITEMS, ["q1"]);
  });
});

describe("listPricing / listInactivePricing (local)", () => {
  it("shares one SQL const with an integer boolean param: 1 for active, 0 for inactive", async () => {
    const fake = fakeReads(
      new Map([
        [SQL_PRICING, [{ id: "p1", name: "Call-out", description: null, category: "Labour", pricing_type: "fixed", unit_price: "95.00", unit: "each" }]],
      ])
    );
    setLocalReads(fake);

    await expect(listPricing()).resolves.toEqual([
      { id: "p1", name: "Call-out", description: null, category: "Labour", pricing_type: "fixed", unit_price: 95, unit: "each" },
    ]);
    expect(fake.getAll).toHaveBeenLastCalledWith(SQL_PRICING, [1]);

    await listInactivePricing();
    expect(fake.getAll).toHaveBeenLastCalledWith(SQL_PRICING, [0]);

    expect(norm(SQL_PRICING)).toBe(
      "SELECT id, name, description, category, pricing_type, unit_price, unit " +
        "FROM pricing_items WHERE is_active = ? " +
        "ORDER BY category COLLATE NOCASE, name COLLATE NOCASE"
    );
  });
});

describe("role gate", () => {
  it("routes a technician to Supabase even with a ready local source — the fake is never touched", async () => {
    const fake = fakeReads(new Map(), "technician");
    setLocalReads(fake);

    await expect(listPricing()).resolves.toEqual([]);
    await expect(listInvoices(0, 20)).resolves.toEqual([]);

    expect(fake.getAll).not.toHaveBeenCalled();
    expect(fake.getOptional).not.toHaveBeenCalled();
    expect(supabase.from as unknown as jest.Mock).toHaveBeenCalledWith("pricing_items");
    expect(supabase.from as unknown as jest.Mock).toHaveBeenCalledWith("invoices");
  });
});
