import { statusDomains } from "./status";
import * as web from "../../../lib/badge-colors";

// PARITY GUARD: the mobile status token map must cover every domain+value the
// web's single source of truth (lib/badge-colors.ts) defines. If the web adds a
// status (e.g. a new job status) and mobile doesn't, this test fails the build —
// keeping "full parity" honest over time.
//
// Maps web export name -> mobile domain key.
const domainMap: Record<string, keyof typeof statusDomains> = {
  jobStatusColors: "jobStatus",
  jobPriorityColors: "jobPriority",
  invoiceStatusColors: "invoiceStatus",
  quoteStatusColors: "quoteStatus",
  staffRoleColors: "staffRole",
  equipmentCategoryColors: "equipmentCategory",
  pricingTypeColors: "pricingType",
  photoTagColors: "photoTag",
};

describe("status token parity with web lib/badge-colors.ts", () => {
  for (const [webExport, mobileDomain] of Object.entries(domainMap)) {
    it(`${mobileDomain} covers every key in web ${webExport}`, () => {
      const webMap = (web as Record<string, Record<string, string>>)[webExport];
      expect(webMap).toBeDefined();
      const webKeys = Object.keys(webMap).sort();
      const mobileKeys = Object.keys(statusDomains[mobileDomain]).sort();
      for (const key of webKeys) {
        expect(mobileKeys).toContain(key);
      }
    });
  }
});
