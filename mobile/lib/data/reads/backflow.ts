import { supabase } from "../../supabase";
import { computeNextDueDate, getDueStatus, type DueStatus } from "../../backflow";
import { fromLocalOr, type LocalReads } from "./source";
import { groupByKey, nestOne, num } from "./rowMap";

export interface BackflowDevice {
  id: string;
  water_authority: string;
  serial_number: string | null;
  test_frequency_months: number;
  customers: { name: string } | null;
  sites: { name: string; suburb: string } | null;
  backflow_tests: { test_date: string; result: string }[];
}

export interface BackflowRow {
  device: BackflowDevice;
  nextDueDate: Date | null;
  status: DueStatus;
}

// Worst-first ordering, then earliest due date breaks ties.
const STATUS_ORDER: Record<DueStatus, number> = { overdue: 0, due_soon: 1, no_test: 2, ok: 3 };

// Pure: for each device pick the LATEST passing test (failing tests are ignored),
// derive its next-due date + due status, then sort worst-first. Read-repository
// so a future offline cache swaps in without touching the screens.
export function computeBackflowRows(devices: BackflowDevice[]): BackflowRow[] {
  const rows = devices.map((device) => {
    const passing = (device.backflow_tests ?? []).filter((t) => t.result === "pass");
    const lastPass = passing.sort((a, b) => (a.test_date < b.test_date ? 1 : -1))[0];
    const nextDueDate = computeNextDueDate(lastPass?.test_date, Number(device.test_frequency_months));
    return { device, nextDueDate, status: getDueStatus(nextDueDate) };
  });
  rows.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.nextDueDate?.getTime() ?? 0) - (b.nextDueDate?.getTime() ?? 0)
  );
  return rows;
}

// Local SQL (design §3.2). Money-free and technician-reachable, so no role
// gate: every role's device DB carries these tables.
export const SQL_LIST_BACKFLOW_DEVICES = `
  SELECT d.id, d.water_authority, d.serial_number, d.test_frequency_months,
         c.name AS customer_name, s.name AS site_name, s.suburb AS site_suburb
  FROM backflow_devices d
  LEFT JOIN customers c ON c.id = d.customer_id
  LEFT JOIN sites     s ON s.id = d.site_id
  WHERE d.is_active = 1
  ORDER BY d.created_at DESC`;

export const SQL_LIST_BACKFLOW_TESTS = `
  SELECT device_id, test_date, result
  FROM backflow_tests
  WHERE device_id IN (SELECT id FROM backflow_devices WHERE is_active = 1)`;

interface RawDeviceRow {
  id: string;
  water_authority: string;
  serial_number: string | null;
  test_frequency_months: number | string;
  customer_name: string | null;
  site_name: string | null;
  site_suburb: string | null;
}

interface RawTestRow {
  device_id: string;
  test_date: string;
  result: string;
}

// customers.name / sites.name are NOT NULL (0000_baseline.sql:49, :71), so a
// null join alias can only mean the FK was null — which is exactly when
// PostgREST returns a null embed (not `{ name: null }`). nestOne keys on that.
function mapDevices(deviceRows: RawDeviceRow[], testRows: RawTestRow[]): BackflowDevice[] {
  const testsByDevice = groupByKey(testRows, "device_id");
  return deviceRows.map((d) => ({
    id: d.id,
    water_authority: d.water_authority,
    serial_number: d.serial_number,
    test_frequency_months: num(d.test_frequency_months),
    customers: nestOne(d.customer_name, { name: d.customer_name as string }),
    sites: nestOne(d.site_name, { name: d.site_name as string, suburb: d.site_suburb as string }),
    backflow_tests: (testsByDevice.get(d.id) ?? []).map((t) => ({
      test_date: t.test_date,
      result: t.result,
    })),
  }));
}

async function listBackflowDevicesLocal(db: LocalReads): Promise<BackflowRow[]> {
  const deviceRows = await db.getAll<RawDeviceRow>(SQL_LIST_BACKFLOW_DEVICES);
  const testRows = await db.getAll<RawTestRow>(SQL_LIST_BACKFLOW_TESTS);
  return computeBackflowRows(mapDevices(deviceRows, testRows));
}

export async function listBackflowDevices(): Promise<BackflowRow[]> {
  return fromLocalOr(
    listBackflowDevicesLocal,
    // Unchanged Supabase body — the byte-identical fallback.
    async () => {
      const { data } = await supabase
        .from("backflow_devices")
        .select("id, water_authority, serial_number, test_frequency_months, customers(name), sites(name, suburb), backflow_tests(test_date, result)")
        .eq("is_active", true)
        .order("created_at", { ascending: false });
      return computeBackflowRows((data as unknown as BackflowDevice[]) ?? []);
    }
  );
}
