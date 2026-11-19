import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as webHire from "@/lib/hire-pricing";
import * as phoneHire from "../../mobile/lib/hireLabels";

// The phone's Fleet office screens (service history, hire setup, year cost)
// use copies of the web's pure rules. Both must agree on when a service is
// due, which form fields an invoice read fills, how a financial year's costs
// add up and what each way of hiring is called — or the office sees one
// thing on the website and another on the phone.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** The file without its leading comment block. */
const afterHeader = (p: string) => {
  const lines = read(p).split("\n");
  let i = 0;
  while (i < lines.length && (lines[i].startsWith("//") || lines[i] === "")) i++;
  return lines.slice(i).join("\n");
};
const belowImports = (p: string) => {
  const lines = read(p).split("\n");
  let last = -1;
  lines.forEach((l, i) => { if (l.startsWith("import ")) last = i; });
  expect(last).toBeGreaterThan(-1);
  return lines.slice(last + 1).join("\n");
};

describe("Fleet mirrors on the phone", () => {
  it("mobile/lib/serviceDue.ts is lib/service-due.ts", () => {
    expect(afterHeader("mobile/lib/serviceDue.ts")).toBe(afterHeader("lib/service-due.ts"));
  });

  it("mobile/lib/serviceInvoiceForm.ts is lib/service-invoice-form.ts", () => {
    expect(afterHeader("mobile/lib/serviceInvoiceForm.ts")).toBe(afterHeader("lib/service-invoice-form.ts"));
  });

  it("mobile/lib/fleetCosts.ts is lib/fleet-costs.ts below the imports", () => {
    expect(belowImports("mobile/lib/fleetCosts.ts")).toBe(belowImports("lib/fleet-costs.ts"));
  });

  it("mobile/lib/hireLabels.ts has the web's hire vocabulary", () => {
    expect(phoneHire.HIRE_UNITS_BY_TYPE).toEqual(webHire.HIRE_UNITS_BY_TYPE);
    expect(phoneHire.HIRE_TYPE_LABELS).toEqual(webHire.HIRE_TYPE_LABELS);
    expect(phoneHire.HIRE_UNIT_LABELS).toEqual(webHire.HIRE_UNIT_LABELS);
    expect(phoneHire.DEFAULT_COST_CENTRE_BY_TYPE).toEqual(webHire.DEFAULT_COST_CENTRE_BY_TYPE);
    for (const t of Object.keys(webHire.HIRE_UNITS_BY_TYPE) as webHire.HireType[]) {
      for (const u of webHire.HIRE_UNITS_BY_TYPE[t]) {
        expect(phoneHire.hireOptionLabel({ hire_type: t, hire_unit: u })).toBe(webHire.hireOptionLabel({ hire_type: t, hire_unit: u }));
      }
    }
    for (const km of [0, 30, 50, 112.5]) {
      const o = { float_base: 470, float_km_included: 30, float_per_km: 5 };
      expect(phoneHire.floatMoveCharge(km, o)).toBe(webHire.floatMoveCharge(km, o as never));
    }
  });
});
