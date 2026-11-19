import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The phone's office invoice screens (payments, Owed to us, progress claims,
// the builder-PO picker, Push to Xero / Delete wording) run copies of these
// web rules. The server routes are the authority; these pin the copies so the
// phone never offers or says something different from the web.

/** Everything after the first blank line — each copy has its own header. */
const body = (f: string) => {
  const src = readFileSync(f, "utf8");
  return src.slice(src.indexOf("\n\n") + 2);
};

const MIRRORS: Array<[string, string]> = [
  ["lib/invoice-payments.ts", "mobile/lib/invoicePayments.ts"],
  ["lib/progress-claim.ts", "mobile/lib/progressClaim.ts"],
  ["lib/po-invoice.ts", "mobile/lib/poInvoice.ts"],
  ["lib/invoice-actions.ts", "mobile/lib/invoiceActions.ts"],
  ["lib/customer-po.ts", "mobile/lib/customerPo.ts"],
];

describe("phone copies of the invoice rules", () => {
  for (const [web, phone] of MIRRORS) {
    it(`${phone} is byte-identical to ${web} below its header`, () => {
      expect(body(phone)).toBe(body(web));
      expect(body(phone).length).toBeGreaterThan(200);
    });
  }
});
