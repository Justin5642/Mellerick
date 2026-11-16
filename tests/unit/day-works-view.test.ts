import { describe, it, expect } from "vitest";
import { buildDayWorksView, type EntryRow, type MachineRow } from "@/lib/day-works-view";

// The Day Works tab's payload is built from office-only rate tables read with
// the service role. A technician must get quantities and names, never a dollar
// figure (HANDOVER §2) — checked here at every depth, by key name AND by value,
// so a rate copied under an innocent key would still be caught.

const machines: MachineRow[] = [
  {
    id: "bobcat",
    name: "Kubota SVL75",
    is_active: true,
    options: [{ equipment_id: "bobcat", hire_type: "wet", hire_unit: "hour", rate: 115.37, cost_centre_id: "cc-wet", is_active: true }],
  },
  {
    id: "quad",
    name: "Quad axle float",
    is_active: true,
    options: [{ equipment_id: "quad", hire_type: "float", hire_unit: "move", rate: 0, float_base: 471.13, float_km_included: 30, float_per_km: 5.17, cost_centre_id: "cc-float" }],
  },
  { id: "pc18", name: "PC18", is_active: true, options: [{ equipment_id: "pc18", hire_type: "dry", hire_unit: "day", rate: 251.19, is_active: false }] },
  { id: "old", name: "Retired dozer", is_active: false, options: [{ equipment_id: "old", hire_type: "wet", hire_unit: "hour", rate: 209.11 }] },
];
const attachments = [{ id: "trencher", name: "Trencher", day_rate: 203.47, is_active: true }];

const base = {
  job_id: "job-1",
  pickup: null,
  dropoff: null,
  description: "Trenching",
  signer_name: null,
  signature_path: null,
  signed_at: null,
  invoice_id: null,
  void_reason: null,
  created_by: "tech-1",
  hours: null,
  days: null,
  meter_open: null,
  meter_close: null,
  km: null,
};
const entries: EntryRow[] = [
  { ...base, id: "e1", equipment_id: "bobcat", hire_type: "wet", hire_unit: "hour", work_date: "2026-11-10", hours: "6.50", cost_centre_id: "cc-wet", status: "signed", attachment_ids: ["trencher"] },
  { ...base, id: "e2", equipment_id: "quad", hire_type: "float", hire_unit: "move", work_date: "2026-11-10", km: "52.0", cost_centre_id: "cc-float", status: "draft", attachment_ids: [] },
];
const others = [{ entry_id: "x9", attachment_id: "trencher", equipment_id: "pc18", work_date: "2026-11-10", status: "signed", job_number: 812 }];
const centres = new Map([
  ["cc-wet", "Plant Wet Hire"],
  ["cc-float", "Float Moves"],
]);

const view = (isOffice: boolean) =>
  buildDayWorksView({ isOffice, jobId: "job-1", machines, attachments, entries, others, costCentreNames: centres, signatureUrls: new Map() });

const MONEY_KEY = /(rate|cost|price|amount|total|charge|fee|value|base|per_km|pricing|gst|margin)/i;
// The cost centre's NAME is a label, not a figure (the sweep exempts cost_center_id the same way).
const NOT_MONEY = new Set(["cost_centre"]);

function walk(v: unknown, path: string, out: { keys: string[]; numbers: number[] }) {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (MONEY_KEY.test(k) && !NOT_MONEY.has(k)) out.keys.push(`${path}.${k}`);
      walk(x, `${path}.${k}`, out);
    }
  } else if (typeof v === "number") out.numbers.push(v);
}

describe("Day Works payload — the money rule", () => {
  it("a technician's payload has no money-named key and no rate or amount value", () => {
    const out = { keys: [] as string[], numbers: [] as number[] };
    walk(view(false), "view", out);
    expect(out.keys).toEqual([]);
    // Every rate and every amount these rates would produce, by value.
    const rates = [115.37, 471.13, 5.17, 251.19, 209.11, 203.47];
    const amounts = [6.5 * 115.37, 471.13 + 22 * 5.17, 6.5 * 115.37 + 203.47].map((n) => Math.round(n * 100) / 100);
    for (const r of [...rates, ...amounts]) expect(out.numbers).not.toContain(r);
  });

  it("the technician still gets what they need: machines, hire options, quantities, cost centre names", () => {
    const v = view(false);
    expect(v.machines.map((m) => m.name)).toEqual(["Kubota SVL75", "Quad axle float"]); // inactive option / machine left out
    expect(v.machines[0].options[0]).toEqual({ hire_type: "wet", hire_unit: "hour", label: "Wet hire, per hour", whole_days_only: false, fuel_included: false });
    expect(v.entries[0]).toMatchObject({ equipment: "Kubota SVL75", hours: 6.5, cost_centre: "Plant Wet Hire", attachment_ids: ["trencher"] });
    expect(v.entries[1]).toMatchObject({ km: 52, hire_label: "Float move" });
    expect(v.attachments).toEqual([{ id: "trencher", name: "Trencher" }]);
    expect(v.pricing).toBeUndefined();
  });

  it("flags the trencher on another machine the same day, naming the other job", () => {
    expect(view(false).clashes).toEqual([
      { attachment: "Trencher", work_date: "2026-11-10", entry_ids: ["e1"], machines: ["Kubota SVL75 (this job)", "PC18 (job #812)"] },
    ]);
  });

  it("the office gets amounts by entry and by cost centre", () => {
    const p = view(true).pricing!;
    expect(p.entries.e1).toEqual({ machine: 749.91, attachments: 203.47, total: 953.38, quantity: 6.5, unitPrice: 115.37 });
    expect(p.entries.e2.total).toBe(584.87);
    expect(p.byCostCentre).toEqual([
      { name: "Plant Wet Hire", amount: 953.38, entries: 1, unpriced: 0 },
      { name: "Float Moves", amount: 584.87, entries: 1, unpriced: 0 },
    ]);
    expect(p.uninvoicedSigned).toBe(953.38);
  });
});
