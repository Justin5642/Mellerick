import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The phone's PO tab (mobile/components/job/purchase-orders.tsx) checks its
// forms with the same rules the web and the PO routes use. The copies must
// not drift: identical apart from comment lines.
const body = (f: string) => readFileSync(f, "utf8").replace(/^\/\/.*$/gm, "").trim();

describe("builder PO rules mirrored on the phone", () => {
  it.each([
    ["lib/builder-po.ts", "mobile/lib/builderPo.ts"],
    ["lib/po-invoice.ts", "mobile/lib/poInvoice.ts"],
  ])("%s and %s are identical apart from comments", (web, phone) => {
    expect(body(phone)).toBe(body(web));
  });
});
