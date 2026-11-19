// mobile/lib/hireLabels.ts copies the hire vocabulary from the web's
// lib/hire-pricing.ts. They must agree, or Fleet → Hire setup on the phone
// offers different units or labels from the website. (Run here rather than in
// the web's vitest suite: importing a mobile file there needs the Expo
// tsconfig, which CI's web job does not install.)
import * as webHire from "../../lib/hire-pricing";
import * as phoneHire from "./hireLabels";

describe("mobile/lib/hireLabels.ts mirrors lib/hire-pricing.ts", () => {
  it("has the web's hire vocabulary and float maths", () => {
    expect(phoneHire.HIRE_UNITS_BY_TYPE).toEqual(webHire.HIRE_UNITS_BY_TYPE);
    expect(phoneHire.HIRE_TYPE_LABELS).toEqual(webHire.HIRE_TYPE_LABELS);
    expect(phoneHire.HIRE_UNIT_LABELS).toEqual(webHire.HIRE_UNIT_LABELS);
    expect(phoneHire.DEFAULT_COST_CENTRE_BY_TYPE).toEqual(webHire.DEFAULT_COST_CENTRE_BY_TYPE);
    for (const t of Object.keys(webHire.HIRE_UNITS_BY_TYPE) as webHire.HireType[]) {
      for (const u of webHire.HIRE_UNITS_BY_TYPE[t]) {
        expect(phoneHire.hireOptionLabel({ hire_type: t, hire_unit: u })).toBe(
          webHire.hireOptionLabel({ hire_type: t, hire_unit: u }),
        );
      }
    }
    for (const km of [0, 30, 50, 112.5]) {
      const o = { float_base: 470, float_km_included: 30, float_per_km: 5 };
      expect(phoneHire.floatMoveCharge(km, o)).toBe(webHire.floatMoveCharge(km, o as never));
    }
  });
});
