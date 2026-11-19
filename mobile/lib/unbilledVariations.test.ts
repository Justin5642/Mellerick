import { approvedAgo, groupUnbilledVariations, variationQtyText, type UnbilledVariation } from "./unbilledVariations";

const job = (id: string, title = "Sewer", invoices: { id: string; invoice_number: number; status: string }[] = []) => ({
  id,
  job_number: 100,
  title,
  customer_id: "c1",
  customers: { name: "Acme" },
  invoices,
});

function v(over: Partial<UnbilledVariation>): UnbilledVariation {
  return {
    id: "v",
    custom_name: null,
    variation_type_id: "t1",
    quantity: 3,
    unit: "m³",
    total_amount: 100,
    approved_at: "2026-11-17T00:00:00Z",
    logged_at: null,
    variation_types: { name: "Spoil" },
    jobs: job("j1"),
    ...over,
  };
}

describe("groupUnbilledVariations", () => {
  it("groups by job with totals, and leaves the QA fixture out", () => {
    const r = groupUnbilledVariations([
      v({ id: "a", total_amount: 100 }),
      v({ id: "b", total_amount: "50.5" }),
      v({ id: "c", jobs: job("j2", "Storm", [{ id: "inv9", invoice_number: 9, status: "sent" }]), total_amount: 20 }),
      v({ id: "qa", jobs: job("j3", "QA FIXTURE — do not invoice"), total_amount: 999 }),
    ]);
    expect(r.count).toBe(3);
    expect(r.total).toBeCloseTo(170.5);
    expect(r.groups.map((g) => [g.job.id, g.total, g.existingInvoice?.invoice_number ?? null])).toEqual([
      ["j1", 150.5, null],
      ["j2", 20, 9],
    ]);
  });
});

describe("variationQtyText / approvedAgo", () => {
  it("drops the quantity of a custom lump sum", () => {
    expect(variationQtyText({ variation_type_id: null, quantity: 1, unit: "ea" })).toBe("");
    expect(variationQtyText({ variation_type_id: "t", quantity: 3, unit: "m³" })).toBe("3 m³");
  });
  it("says how long it has waited", () => {
    const now = Date.parse("2026-11-19T10:00:00Z");
    expect(approvedAgo({ approved_at: "2026-11-19T01:00:00Z", logged_at: null }, now)).toBe("approved today");
    expect(approvedAgo({ approved_at: "2026-11-18T09:00:00Z", logged_at: null }, now)).toBe("approved 1 day ago");
    expect(approvedAgo({ approved_at: null, logged_at: null }, now)).toBeNull();
  });
});
