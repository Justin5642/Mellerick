import { describe, it, expect } from "vitest";
import { ageBucket, balanceOf, daysOverdue, summarizeOwed, type OwedInvoice } from "@/lib/invoice-payments";

const inv = (over: Partial<OwedInvoice>): OwedInvoice => ({
  id: "i",
  invoice_number: 1,
  title: "t",
  total: 1000,
  amount_paid: 0,
  due_date: "2026-10-19",
  status: "sent",
  customers: { name: "Acme" },
  ...over,
});

describe("balanceOf", () => {
  it("is total less amount paid, to the cent", () => {
    expect(balanceOf({ total: "1000.00", amount_paid: "399.995" })).toBe(600.01);
  });
  it("never goes negative on an overpayment", () => {
    expect(balanceOf({ total: 100, amount_paid: 150 })).toBe(0);
  });
});

describe("ageing", () => {
  it("counts days past due by calendar day", () => {
    expect(daysOverdue("2026-10-01", "2026-10-19")).toBe(18);
    expect(daysOverdue("2026-10-25", "2026-10-19")).toBe(-6);
    expect(daysOverdue(null, "2026-10-19")).toBe(0);
  });
  it("buckets at 30/60/90 day boundaries", () => {
    expect(ageBucket("2026-10-19", "2026-10-19")).toBe("current");
    expect(ageBucket("2026-09-19", "2026-10-19")).toBe("1-30");
    expect(ageBucket("2026-09-18", "2026-10-19")).toBe("31-60");
    expect(ageBucket("2026-08-19", "2026-10-19")).toBe("61-90");
    expect(ageBucket("2026-07-01", "2026-10-19")).toBe("90+");
  });
});

describe("summarizeOwed", () => {
  it("totals balances (not totals) and splits overdue from not-yet-due", () => {
    const s = summarizeOwed(
      [
        inv({ id: "a", total: 1000, amount_paid: 400, due_date: "2026-10-30" }),
        inv({ id: "b", total: 500, due_date: "2026-09-01", status: "overdue" }),
        inv({ id: "c", total: 200, status: "paid" }),
        inv({ id: "d", total: 300, status: "draft" }),
        inv({ id: "e", total: 100, amount_paid: 100 }),
      ],
      "2026-10-19"
    );
    expect(s.outstanding).toBe(1100);
    expect(s.overdue).toBe(500);
    expect(s.count).toBe(2);
    expect(s.buckets.find((b) => b.key === "current")!.invoices.map((i) => i.id)).toEqual(["a"]);
    expect(s.buckets.find((b) => b.key === "31-60")!.total).toBe(500);
  });
});
