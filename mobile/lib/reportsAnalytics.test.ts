import { topCustomersBySpend, revenueByMonth, jobsByStaff, type InvoiceRow, type JobStaffRow } from "./reportsAnalytics";

const inv = (over: Partial<InvoiceRow>): InvoiceRow => ({ customer_id: "c1", customer_name: "Acme", total: 100, status: "paid", created_at: "2026-07-10T00:00:00Z", ...over });

describe("topCustomersBySpend", () => {
  it("sums non-cancelled totals per customer, highest first, capped", () => {
    const rows = [
      inv({ customer_id: "c1", customer_name: "Acme", total: 100 }),
      inv({ customer_id: "c1", customer_name: "Acme", total: 50 }),
      inv({ customer_id: "c2", customer_name: "Beta", total: 300 }),
      inv({ customer_id: "c3", customer_name: "Gamma", total: 999, status: "cancelled" }), // excluded
    ];
    const r = topCustomersBySpend(rows, 2);
    expect(r).toEqual([
      { customerId: "c2", name: "Beta", total: 300 },
      { customerId: "c1", name: "Acme", total: 150 },
    ]);
  });
});

describe("revenueByMonth", () => {
  it("buckets paid vs outstanding by created_at month", () => {
    const rows = [
      inv({ total: 100, status: "paid", created_at: "2026-06-15T00:00:00Z" }),
      inv({ total: 200, status: "sent", created_at: "2026-06-20T00:00:00Z" }),
      inv({ total: 50, status: "overdue", created_at: "2026-07-01T00:00:00Z" }),
      inv({ total: 999, status: "draft", created_at: "2026-07-02T00:00:00Z" }), // neither paid nor outstanding
      inv({ total: 400, status: "paid", created_at: "2026-07-05T00:00:00Z" }),
    ];
    expect(revenueByMonth(rows, ["2026-06", "2026-07"])).toEqual([
      { monthKey: "2026-06", paid: 100, outstanding: 200 },
      { monthKey: "2026-07", paid: 400, outstanding: 50 },
    ]);
  });
});

describe("jobsByStaff", () => {
  it("counts total + completed per assignee with a completion rate, highest total first, EXCLUDING unassigned (web parity)", () => {
    const jobs: JobStaffRow[] = [
      { assignee_name: "Sam", status: "completed" },
      { assignee_name: "Sam", status: "completed" },
      { assignee_name: "Sam", status: "in_progress" },
      { assignee_name: "Jo", status: "completed" },
      { assignee_name: null, status: "pending" }, // unassigned → excluded
    ];
    const r = jobsByStaff(jobs);
    expect(r[0]).toEqual({ name: "Sam", completed: 2, total: 3, rate: (2 / 3) * 100 });
    expect(r).toContainEqual({ name: "Jo", completed: 1, total: 1, rate: 100 });
    expect(r.some((x) => x.name === "Unassigned")).toBe(false); // no unassigned row
    expect(r).toHaveLength(2);
  });
});
