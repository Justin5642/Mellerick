// London-school test of the backflow read through the LocalReads seam: a fake
// local DB returns SQLite-shaped rows (joins flattened to aliases, numerics as
// numbers because the client schema declares column.real, null FKs as null
// aliases) and the module must produce exactly the PostgREST-shaped rows the
// screens were built against. The Supabase client is mocked per backflow.test.ts.
const mockFrom = jest.fn();
jest.mock("../../supabase", () => ({
  supabase: { from: (...args: unknown[]) => mockFrom(...args) },
}));

import { resetSourceForTests, setLocalReads, type LocalReads } from "./source";
import { computeBackflowRows, listBackflowDevices, type BackflowDevice } from "./backflow";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

// Written out independently of the exported consts so a drive-by edit to the
// module's SQL fails here, not on a device.
const EXPECTED_DEVICES_SQL = norm(`
  SELECT d.id, d.water_authority, d.serial_number, d.test_frequency_months,
         c.name AS customer_name, s.name AS site_name, s.suburb AS site_suburb
  FROM backflow_devices d
  LEFT JOIN customers c ON c.id = d.customer_id
  LEFT JOIN sites s ON s.id = d.site_id
  WHERE d.is_active = 1
  ORDER BY d.created_at DESC`);

const EXPECTED_TESTS_SQL = norm(`
  SELECT device_id, test_date, result
  FROM backflow_tests
  WHERE device_id IN (SELECT id FROM backflow_devices WHERE is_active = 1)`);

// SQLite-shaped rows, exactly as the PowerSync views would return them.
const deviceRows = [
  {
    id: "d1",
    water_authority: "yarra_valley_water",
    serial_number: "SN-100",
    test_frequency_months: 12,
    customer_name: "Acme Water",
    site_name: "Depot",
    site_suburb: "Richmond",
  },
  {
    // site_id is NULL → the LEFT JOIN aliases come back null.
    id: "d2",
    water_authority: "south_east_water",
    serial_number: null,
    test_frequency_months: 12,
    customer_name: "Beta Plumbing",
    site_name: null,
    site_suburb: null,
  },
  {
    id: "d3",
    water_authority: "greater_western_water",
    serial_number: "SN-300",
    test_frequency_months: 120,
    customer_name: "Acme Water",
    site_name: "Plant",
    site_suburb: "Sunshine",
  },
];

const testRows = [
  { device_id: "d1", test_date: "2010-01-01", result: "pass" }, // long overdue
  { device_id: "d1", test_date: "2024-05-01", result: "fail" }, // later fail — ignored by compute
  { device_id: "d3", test_date: "2026-06-01", result: "pass" }, // + 120 months → ok
  // d2 has no tests → no_test
];

// The same devices in PostgREST embed shape: null embeds (not {name: null}),
// numeric test_frequency_months, to-many array present (empty when no tests).
const postgrestDevices: BackflowDevice[] = [
  {
    id: "d1",
    water_authority: "yarra_valley_water",
    serial_number: "SN-100",
    test_frequency_months: 12,
    customers: { name: "Acme Water" },
    sites: { name: "Depot", suburb: "Richmond" },
    backflow_tests: [
      { test_date: "2010-01-01", result: "pass" },
      { test_date: "2024-05-01", result: "fail" },
    ],
  },
  {
    id: "d2",
    water_authority: "south_east_water",
    serial_number: null,
    test_frequency_months: 12,
    customers: { name: "Beta Plumbing" },
    sites: null,
    backflow_tests: [],
  },
  {
    id: "d3",
    water_authority: "greater_western_water",
    serial_number: "SN-300",
    test_frequency_months: 120,
    customers: { name: "Acme Water" },
    sites: { name: "Plant", suburb: "Sunshine" },
    backflow_tests: [{ test_date: "2026-06-01", result: "pass" }],
  },
];

function fakeReads(over: Partial<LocalReads> = {}): LocalReads {
  return {
    hasSynced: () => true,
    role: () => "technician", // backflow is served locally to ALL roles
    getAll: jest.fn(async (sql: string) =>
      norm(sql).includes("FROM backflow_tests") ? (testRows as never[]) : (deviceRows as never[])
    ) as LocalReads["getAll"],
    getOptional: jest.fn().mockResolvedValue(null),
    ...over,
  };
}

afterEach(() => {
  resetSourceForTests();
  jest.clearAllMocks();
});

describe("listBackflowDevices (local path)", () => {
  it("maps SQLite-shaped rows to the exact PostgREST shape and never touches Supabase", async () => {
    const fake = fakeReads();
    setLocalReads(fake);

    const rows = await listBackflowDevices();

    expect(rows).toEqual(computeBackflowRows(postgrestDevices));
    // Worst-first: d1 overdue, d2 no_test, d3 ok.
    expect(rows.map((r) => r.device.id)).toEqual(["d1", "d2", "d3"]);
    expect(mockFrom).not.toHaveBeenCalled();

    const calls = (fake.getAll as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(norm(calls[0][0])).toBe(EXPECTED_DEVICES_SQL);
    expect(calls[0][1]).toBeUndefined(); // no params
    expect(norm(calls[1][0])).toBe(EXPECTED_TESTS_SQL);
    expect(calls[1][1]).toBeUndefined();
  });

  it("yields sites: null (not {name: null, suburb: null}) when site_id is null", async () => {
    setLocalReads(fakeReads());
    const rows = await listBackflowDevices();
    const d2 = rows.find((r) => r.device.id === "d2")!;
    expect(d2.device.sites).toBeNull();
    expect(d2.device.customers).toEqual({ name: "Beta Plumbing" });
    expect(d2.device.backflow_tests).toEqual([]);
    expect(d2.status).toBe("no_test");
  });

  it("is not role-gated: a technician is served locally", async () => {
    const fake = fakeReads({ role: () => "technician" });
    setLocalReads(fake);
    await listBackflowDevices();
    expect(fake.getAll).toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe("listBackflowDevices (remote fallback)", () => {
  it("runs the unchanged Supabase query when no local source is registered", async () => {
    const order = jest.fn().mockResolvedValue({ data: postgrestDevices });
    const eq = jest.fn().mockReturnValue({ order });
    const select = jest.fn().mockReturnValue({ eq });
    mockFrom.mockReturnValue({ select });

    const rows = await listBackflowDevices();

    expect(rows).toEqual(computeBackflowRows(postgrestDevices));
    expect(mockFrom).toHaveBeenCalledWith("backflow_devices");
    expect(select).toHaveBeenCalledWith(
      "id, water_authority, serial_number, test_frequency_months, customers(name), sites(name, suburb), backflow_tests(test_date, result)"
    );
    expect(eq).toHaveBeenCalledWith("is_active", true);
    expect(order).toHaveBeenCalledWith("created_at", { ascending: false });
  });

  it("falls back to the Supabase body when the local query throws", async () => {
    const order = jest.fn().mockResolvedValue({ data: [] });
    const eq = jest.fn().mockReturnValue({ order });
    const select = jest.fn().mockReturnValue({ eq });
    mockFrom.mockReturnValue({ select });
    setLocalReads(
      fakeReads({ getAll: jest.fn().mockRejectedValue(new Error("no such table: backflow_devices")) })
    );

    await expect(listBackflowDevices()).resolves.toEqual([]);
    expect(mockFrom).toHaveBeenCalledWith("backflow_devices");
  });
});
