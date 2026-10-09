// Backflow device detail: local and remote must return IDENTICAL shapes.
const mockCalls: { table: string; chain: [string, unknown[]][] }[] = [];
const mockResponses: Record<string, unknown> = {};
jest.mock("../../supabase", () => ({
  supabase: {
    from: (table: string) => {
      const entry = { table, chain: [] as [string, unknown[]][] };
      mockCalls.push(entry);
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "single"]) {
        builder[m] = (...args: unknown[]) => {
          entry.chain.push([m, args]);
          return builder;
        };
      }
      builder.then = (resolve: (v: unknown) => unknown) => resolve(mockResponses[table] ?? { data: [], error: null });
      return builder;
    },
  },
}));

import { resetSourceForTests, setLocalReads, type LocalReads } from "./source";
import {
  getBackflowDeviceWithTests,
  SQL_GET_BACKFLOW_DEVICE,
  SQL_LIST_DEVICE_TESTS,
  type BackflowDeviceWithTests,
} from "./backflow";

const SQLITE_DEVICE = {
  id: "d1", customer_id: "c1", site_id: null, water_authority: "yarra_valley_water", device_type: "rpzd",
  make: "Watts", model: "009", serial_number: "SN1", size_mm: "25", location_description: "Meter box",
  test_frequency_months: 12, water_meter_number: null,
  customer_name: "Acme", site_name: null, site_address_line1: null, site_suburb: null, site_state: null, site_postcode: null,
};
const SQLITE_TESTS = [
  {
    id: "t2", test_type: "annual", test_date: "2026-09-01", result: "pass", tester_name: "Jake", tested_by: "u1",
    submitted_to_water_authority_at: "2026-09-02T00:00:00Z", certificate_storage_path: "d1/cert.pdf", tester_full_name: "Jake H",
  },
  {
    id: "t1", test_type: "commissioning", test_date: "2025-09-01", result: "fail", tester_name: "Old", tested_by: null,
    submitted_to_water_authority_at: null, certificate_storage_path: null, tester_full_name: null,
  },
];

const EXPECTED: BackflowDeviceWithTests = {
  device: {
    id: "d1", customer_id: "c1", site_id: null, water_authority: "yarra_valley_water", device_type: "rpzd",
    make: "Watts", model: "009", serial_number: "SN1", size_mm: 25, location_description: "Meter box",
    test_frequency_months: 12, water_meter_number: null, customers: { name: "Acme" }, sites: null,
  },
  tests: [
    {
      id: "t2", test_type: "annual", test_date: "2026-09-01", result: "pass", tester_name: "Jake", tested_by: "u1",
      submitted_to_water_authority_at: "2026-09-02T00:00:00Z", certificate_storage_path: "d1/cert.pdf",
      profiles: { full_name: "Jake H" },
    },
    {
      id: "t1", test_type: "commissioning", test_date: "2025-09-01", result: "fail", tester_name: "Old", tested_by: null,
      submitted_to_water_authority_at: null, certificate_storage_path: null, profiles: null,
    },
  ],
};

function fakeReads(device: unknown): LocalReads & { getAll: jest.Mock; getOptional: jest.Mock } {
  return {
    hasSynced: () => true,
    role: () => "technician",
    getAll: jest.fn(async (sql: string) => (sql === SQL_LIST_DEVICE_TESTS ? SQLITE_TESTS : [])),
    getOptional: jest.fn(async (sql: string) => (sql === SQL_GET_BACKFLOW_DEVICE ? device : null)),
  } as LocalReads & { getAll: jest.Mock; getOptional: jest.Mock };
}

afterEach(() => {
  resetSourceForTests();
  mockCalls.length = 0;
  for (const k of Object.keys(mockResponses)) delete mockResponses[k];
});

describe("getBackflowDeviceWithTests", () => {
  it("local (any role, technician here) and remote return identical shapes", async () => {
    setLocalReads(fakeReads(SQLITE_DEVICE));
    const local = await getBackflowDeviceWithTests("d1");
    expect(mockCalls).toHaveLength(0);

    resetSourceForTests();
    const { customer_name, site_name, site_address_line1, site_suburb, site_state, site_postcode, ...base } = SQLITE_DEVICE;
    void [customer_name, site_name, site_address_line1, site_suburb, site_state, site_postcode];
    mockResponses.backflow_devices = { data: { ...base, size_mm: 25, customers: { name: "Acme" }, sites: null }, error: null };
    mockResponses.backflow_tests = {
      data: SQLITE_TESTS.map(({ tester_full_name, ...t }) => ({ ...t, profiles: tester_full_name ? { full_name: tester_full_name } : null })),
      error: null,
    };
    const remote = await getBackflowDeviceWithTests("d1");

    expect(local).toEqual(EXPECTED);
    expect(remote).toEqual(EXPECTED);
  });

  it("a device absent from the mirror answers from Supabase (just registered, still in flight)", async () => {
    const db = fakeReads(null);
    setLocalReads(db);
    mockResponses.backflow_devices = { data: null, error: { code: "PGRST116", message: "0 rows" } };
    const result = await getBackflowDeviceWithTests("d1");
    expect(mockCalls.map((c) => c.table).sort()).toEqual(["backflow_devices", "backflow_tests"]);
    expect(result.device).toBeNull(); // PGRST116 → "Device not found", not an error
  });

  it("orders tests newest first on both paths, with the same tie-break", async () => {
    expect(SQL_LIST_DEVICE_TESTS).toMatch(/ORDER BY t\.test_date DESC, t\.created_at DESC/);
    await getBackflowDeviceWithTests("d1");
    const tests = mockCalls.find((c) => c.table === "backflow_tests")!;
    expect(tests.chain.filter(([m]) => m === "order")).toEqual([
      ["order", ["test_date", { ascending: false }]],
      ["order", ["created_at", { ascending: false }]],
    ]);
  });
});
