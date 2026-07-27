// The module imports the supabase client (native AsyncStorage chain); this test
// only exercises the pure computeBackflowRows, so stub the client away.
jest.mock("../../supabase", () => ({ supabase: {} }));

import { computeBackflowRows, type BackflowDevice } from "./backflow";

function device(id: string, tests: { test_date: string; result: string }[], freq = 12): BackflowDevice {
  return {
    id,
    water_authority: "yarra_valley_water",
    serial_number: null,
    test_frequency_months: freq,
    customers: { name: `Cust ${id}` },
    sites: { name: "S", suburb: "Richmond" },
    backflow_tests: tests,
  };
}

describe("computeBackflowRows", () => {
  it("uses the LATEST passing test and ignores failing tests when computing the due date", () => {
    const [row] = computeBackflowRows([
      device("d1", [
        { test_date: "2020-01-01", result: "pass" },
        { test_date: "2023-06-15", result: "pass" },
        { test_date: "2024-02-01", result: "fail" }, // later, but a fail — must be ignored
      ]),
    ]);
    // latest pass 2023-06-15 + 12 months => 2024-06-15
    expect(row.nextDueDate?.getFullYear()).toBe(2024);
    expect(row.nextDueDate?.getMonth()).toBe(5); // June (0-indexed)
    expect(row.nextDueDate?.getDate()).toBe(15);
    expect(row.status).toBe("overdue"); // 2024-06-15 is in the past
  });

  it("marks a device with no passing test as no_test with a null due date", () => {
    const [row] = computeBackflowRows([device("d2", [{ test_date: "2024-01-01", result: "fail" }])]);
    expect(row.nextDueDate).toBeNull();
    expect(row.status).toBe("no_test");
  });

  it("sorts worst-first: overdue, then no_test, then ok", () => {
    const rows = computeBackflowRows([
      device("ok", [{ test_date: "2025-06-01", result: "pass" }], 120), // due ~2035 => ok
      device("none", []), // no_test
      device("late", [{ test_date: "2010-01-01", result: "pass" }], 12), // long overdue
    ]);
    expect(rows.map((r) => r.device.id)).toEqual(["late", "none", "ok"]);
  });
});
