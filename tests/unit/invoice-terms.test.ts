import { describe, expect, it } from "vitest";
import { addDays, dueDateForTerm, melbourneDay, termForDueDate } from "@/lib/invoice-terms";

describe("invoice payment terms", () => {
  it("counts days across month and year ends", () => {
    expect(addDays("2026-11-16", 14)).toBe("2026-11-30");
    expect(addDays("2026-11-16", 30)).toBe("2026-12-16");
    expect(addDays("2026-12-20", 14)).toBe("2027-01-03");
    expect(dueDateForTerm(30, "2027-02-10")).toBe("2027-03-12");
  });

  it("uses the Melbourne day, not UTC", () => {
    // 14:30 UTC on 16 Nov is 01:30 on 17 Nov in Melbourne (daylight time).
    expect(melbourneDay(new Date("2026-11-16T14:30:00Z"))).toBe("2026-11-17");
    expect(melbourneDay(new Date("2026-11-16T10:00:00Z"))).toBe("2026-11-16");
  });

  it("recognises a due date that matches a term, else custom", () => {
    expect(termForDueDate("2026-11-30", "2026-11-16")).toBe(14);
    expect(termForDueDate("2026-12-16", "2026-11-16")).toBe(30);
    expect(termForDueDate("2026-12-01", "2026-11-16")).toBe("custom");
    expect(termForDueDate("", "2026-11-16")).toBe("custom");
  });
});
