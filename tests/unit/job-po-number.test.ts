import { describe, it, expect } from "vitest";
import { nextJobPoNumber } from "@/lib/job-po-number";

describe("nextJobPoNumber", () => {
  it("starts at -1 on a job with no POs", () => {
    expect(nextJobPoNumber(4321, [])).toBe("4321-1");
  });

  it("counts on from the highest already used", () => {
    expect(nextJobPoNumber(4321, ["4321-1", "4321-2"])).toBe("4321-3");
  });

  it("never reuses a number after a PO is deleted", () => {
    expect(nextJobPoNumber(4321, ["4321-2"])).toBe("4321-3");
  });

  it("ignores Simpro and hand-typed numbers, and other jobs' numbers", () => {
    expect(nextJobPoNumber(4321, ["SIMPRO-2816", "PO-77", "43210-5", "4321-x", " 4321-9 "])).toBe("4321-10");
  });
});
