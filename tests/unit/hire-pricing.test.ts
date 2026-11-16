import { describe, it, expect } from "vitest";
import {
  attachmentClashes,
  dayWorksInvoiceTitle,
  floatMoveCharge,
  invoiceLinesFromEntries,
  isValidHireUnit,
  machineCharge,
  priceEntry,
  quantityProblem,
  totalsByCostCentre,
  type HireEntryQuantities,
  type HireOption,
  type InvoiceableEntry,
} from "@/lib/hire-pricing";
import { moneyTotals } from "@/lib/replace-line-items";

// Justin's rates, Nov 2026, ex GST.
const PC88: HireOption = { equipment_id: "pc88", hire_type: "wet", hire_unit: "hour", rate: 146, cost_centre_id: "wet" };
const PC18: HireOption = { equipment_id: "pc18", hire_type: "dry", hire_unit: "day", rate: 250, cost_centre_id: "dry" };
const ROLLER: HireOption = { equipment_id: "roller", hire_type: "dry", hire_unit: "day", rate: 400, whole_days_only: true, cost_centre_id: "dry" };
const SCREENER: HireOption = { equipment_id: "warrior", hire_type: "dry", hire_unit: "engine_hour", rate: "140.00", cost_centre_id: "dry" };
const CAT_WET: HireOption = { equipment_id: "cat", hire_type: "wet", hire_unit: "hour", rate: 200, cost_centre_id: "wet" };
const CAT_DRY: HireOption = { equipment_id: "cat", hire_type: "dry", hire_unit: "day", rate: 800, cost_centre_id: "dry" };
const QUAD: HireOption = { equipment_id: "quad", hire_type: "float", hire_unit: "move", rate: 0, float_base: 470, float_km_included: 30, float_per_km: 5, cost_centre_id: "float" };
const TWIN: HireOption = { equipment_id: "twin", hire_type: "float", hire_unit: "move", rate: 0, float_base: "375.00", float_km_included: "30.0", float_per_km: "5.00", cost_centre_id: "float" };
const TRUCK_KM: HireOption = { equipment_id: "truck", hire_type: "cartage", hire_unit: "km", rate: 2.5, cost_centre_id: "cartage" };
const TRUCK_CONTRACT: HireOption = { equipment_id: "truck", hire_type: "cartage", hire_unit: "contract", rate: 1200, cost_centre_id: "cartage" };
const OPTIONS = [PC88, PC18, ROLLER, SCREENER, CAT_WET, CAT_DRY, QUAD, TWIN, TRUCK_KM, TRUCK_CONTRACT];
const TRENCHER = { id: "trencher", name: "Trencher", day_rate: 200 };

const entry = (o: HireOption, q: Partial<HireEntryQuantities> = {}): HireEntryQuantities => ({
  id: `${o.equipment_id}-${o.hire_type}-${q.work_date ?? "2026-11-10"}`,
  equipment_id: o.equipment_id,
  hire_type: o.hire_type,
  hire_unit: o.hire_unit,
  work_date: "2026-11-10",
  status: "signed",
  ...q,
});

describe("machineCharge — each hire type", () => {
  it("wet hire is hours × the hourly rate", () => {
    expect(machineCharge(entry(PC88, { hours: 7.5 }), PC88)).toEqual({ quantity: 7.5, unitPrice: 146, amount: 1095 });
  });

  it("dry day hire is days × the day rate, half days allowed", () => {
    expect(machineCharge(entry(PC18, { days: 2.5 }), PC18).amount).toBe(625);
  });

  it("the roller charges full days only — a part day rounds up", () => {
    expect(machineCharge(entry(ROLLER, { days: 0.5 }), ROLLER)).toEqual({ quantity: 1, unitPrice: 400, amount: 400 });
    expect(machineCharge(entry(ROLLER, { days: 2 }), ROLLER).quantity).toBe(2);
    expect(machineCharge(entry(ROLLER, { days: 2.1 }), ROLLER).quantity).toBe(3);
  });

  it("engine-hour hire is closing minus opening meter × the rate", () => {
    expect(machineCharge(entry(SCREENER, { meter_open: "1203.4", meter_close: "1209.9" }), SCREENER)).toEqual({ quantity: 6.5, unitPrice: 140, amount: 910 });
    // A meter that went backwards is charged nothing, never negative.
    expect(machineCharge(entry(SCREENER, { meter_open: 10, meter_close: 8 }), SCREENER).amount).toBe(0);
  });

  it("float: the base covers the first 30 km, then $5/km — 50 km on the quad is $570", () => {
    expect(machineCharge(entry(QUAD, { km: 50 }), QUAD)).toEqual({ quantity: 1, unitPrice: 570, amount: 570 });
    expect(floatMoveCharge(30, QUAD)).toBe(470);
    expect(floatMoveCharge(0, QUAD)).toBe(470);
    expect(floatMoveCharge(31.5, TWIN)).toBe(382.5);
  });

  it("cartage by km and by contract", () => {
    expect(machineCharge(entry(TRUCK_KM, { km: 84 }), TRUCK_KM).amount).toBe(210);
    expect(machineCharge(entry(TRUCK_CONTRACT), TRUCK_CONTRACT)).toEqual({ quantity: 1, unitPrice: 1200, amount: 1200 });
  });

  it("one machine with two hire options prices by the option the entry was entered under", () => {
    expect(priceEntry(entry(CAT_WET, { hours: 4 }), OPTIONS, [], []).total).toBe(800);
    expect(priceEntry(entry(CAT_DRY, { days: 1 }), OPTIONS, [], []).total).toBe(800);
    expect(priceEntry(entry(CAT_DRY, { days: 1 }), OPTIONS, [], []).cost_centre_id).toBe("dry");
  });
});

describe("priceEntry — attachments", () => {
  it("each attachment adds a full day at its day rate", () => {
    const p = priceEntry(entry(PC88, { hours: 3 }), OPTIONS, ["trencher"], [TRENCHER]);
    expect(p.machine!.amount).toBe(438);
    expect(p.attachments).toEqual([{ id: "trencher", name: "Trencher", amount: 200 }]);
    expect(p.total).toBe(638);
  });

  it("a machine with no hire setup is unpriced (null), not $0", () => {
    const p = priceEntry({ ...entry(PC88, { hours: 3 }), equipment_id: "unknown" }, OPTIONS, [], []);
    expect(p.total).toBeNull();
    expect(p.machine).toBeNull();
  });
});

describe("quantityProblem", () => {
  it("asks for the quantity each unit needs", () => {
    expect(quantityProblem({ hire_unit: "hour", hours: 0 })).toMatch(/hours/);
    expect(quantityProblem({ hire_unit: "hour", hours: 2 })).toBeNull();
    expect(quantityProblem({ hire_unit: "day" })).toMatch(/days/);
    expect(quantityProblem({ hire_unit: "engine_hour", meter_open: 5 })).toMatch(/meter/);
    expect(quantityProblem({ hire_unit: "engine_hour", meter_open: 5, meter_close: 5 })).toMatch(/higher/);
    expect(quantityProblem({ hire_unit: "engine_hour", meter_open: 0, meter_close: 5 })).toBeNull();
    expect(quantityProblem({ hire_unit: "km", km: 0 })).toMatch(/kilometres/);
    expect(quantityProblem({ hire_unit: "move", km: 0 })).toBeNull();
    expect(quantityProblem({ hire_unit: "move" })).toMatch(/kilometres/);
    expect(quantityProblem({ hire_unit: "contract" })).toBeNull();
  });

  it("hire units match the database's allowed pairs", () => {
    expect(isValidHireUnit("wet", "hour")).toBe(true);
    expect(isValidHireUnit("wet", "day")).toBe(false);
    expect(isValidHireUnit("dry", "engine_hour")).toBe(true);
    expect(isValidHireUnit("float", "km")).toBe(false);
  });
});

describe("attachmentClashes", () => {
  it("flags the same attachment on two machines the same day", () => {
    const clashes = attachmentClashes([
      { id: "a", equipment_id: "bobcat", work_date: "2026-11-10", attachment_ids: ["trencher"] },
      { id: "b", equipment_id: "pc18", work_date: "2026-11-10", attachment_ids: ["trencher"] },
      { id: "c", equipment_id: "pc18", work_date: "2026-11-11", attachment_ids: ["trencher"] },
    ]);
    expect(clashes).toEqual([{ attachmentId: "trencher", workDate: "2026-11-10", entryIds: ["a", "b"], equipmentIds: ["bobcat", "pc18"] }]);
  });

  it("ignores void entries, other days and two moves by the same machine", () => {
    expect(
      attachmentClashes([
        { id: "a", equipment_id: "bobcat", work_date: "2026-11-10", attachment_ids: ["trencher"] },
        { id: "b", equipment_id: "pc18", work_date: "2026-11-10", status: "void", attachment_ids: ["trencher"] },
        { id: "c", equipment_id: "bobcat", work_date: "2026-11-10", attachment_ids: ["trencher"] },
        { id: "d", equipment_id: "pc18", work_date: "2026-11-11", attachment_ids: ["trencher"] },
      ])
    ).toEqual([]);
  });
});

describe("totalsByCostCentre", () => {
  it("adds amounts per cost centre and counts unpriced entries apart", () => {
    const priced = [
      priceEntry(entry(PC88, { hours: 2 }), OPTIONS, [], []),
      priceEntry(entry(CAT_WET, { hours: 1 }), OPTIONS, ["trencher"], [TRENCHER]),
      priceEntry(entry(QUAD, { km: 50 }), OPTIONS, [], []),
      { total: null, cost_centre_id: "wet" },
    ];
    expect(totalsByCostCentre(priced)).toEqual([
      { cost_centre_id: "wet", amount: 692, entries: 3, unpriced: 1 },
      { cost_centre_id: "float", amount: 570, entries: 1, unpriced: 0 },
    ]);
  });
});

describe("invoiceLinesFromEntries", () => {
  const names = new Map([
    ["pc88", "Komatsu PC88"],
    ["quad", "Quad axle float"],
    ["roller", "Roller"],
    ["warrior", "Warrior 1400"],
  ]);
  const signed = (o: HireOption, q: Partial<InvoiceableEntry>): InvoiceableEntry => ({ ...entry(o, q), attachment_ids: [], ...q });

  it("one line per machine-day plus one per attachment, oldest first, adding up to the priced total", () => {
    const entries = [
      signed(QUAD, { work_date: "2026-11-12", km: 50, pickup: "Yard", dropoff: "Lot 4" }),
      signed(PC88, { work_date: "2026-11-10", hours: 8, description: "Bulk excavation", signer_name: "Sam (Builder)", attachment_ids: ["trencher"] }),
      signed(ROLLER, { work_date: "2026-11-11", days: 0.5 }),
      signed(SCREENER, { work_date: "2026-11-11", meter_open: 100, meter_close: 104 }),
    ];
    const lines = invoiceLinesFromEntries(entries, OPTIONS, [TRENCHER], names);
    expect(lines.map((l) => [l.name, l.quantity, l.unit_price])).toEqual([
      ["Komatsu PC88 — Wet hire, per hour", 8, 146],
      ["Trencher (on Komatsu PC88)", 1, 200],
      ["Roller — Dry hire, per day", 1, 400],
      ["Warrior 1400 — Dry hire, per engine hour", 4, 140],
      ["Quad axle float — Float move", 1, 570],
    ]);
    expect(lines[0].description).toBe("10 Nov 2026 · Bulk excavation · signed by Sam (Builder)");
    expect(lines[2].description).toMatch(/0.5 days used, charged in full days/);
    expect(lines[3].description).toMatch(/meter 100–104 = 4 engine hours/);
    expect(lines[4].description).toMatch(/Yard → Lot 4, 50 km loaded/);
    // The invoice totals equal the sum of each entry's priced total.
    const expected = entries.reduce((s, e) => s + priceEntry(e, OPTIONS, e.attachment_ids, [TRENCHER]).total!, 0);
    expect(moneyTotals(lines).subtotal).toBe(expected);
  });

  it("refuses drafts, invoiced or void entries", () => {
    for (const status of ["draft", "invoiced", "void"]) {
      expect(() => invoiceLinesFromEntries([signed(PC88, { hours: 1, status })], OPTIONS, [], names)).toThrow(/signed/);
    }
  });

  it("refuses a machine with no hire rate rather than invoicing it at $0", () => {
    expect(() => invoiceLinesFromEntries([{ ...signed(PC88, { hours: 1 }), hire_type: "dry", hire_unit: "day", days: 1 }], OPTIONS, [], names)).toThrow(/no hire rate/);
  });

  it("titles the invoice with the period", () => {
    expect(dayWorksInvoiceTitle("2026-11-03", "2026-11-09")).toBe("Day Works / Hire — 3 Nov – 9 Nov 2026");
    expect(dayWorksInvoiceTitle("2026-12-29", "2027-01-04")).toBe("Day Works / Hire — 29 Dec 2026 – 4 Jan 2027");
    expect(dayWorksInvoiceTitle("2026-11-03", "2026-11-03")).toBe("Day Works / Hire — 3 Nov 2026");
  });
});
