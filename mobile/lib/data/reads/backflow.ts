import { supabase } from "../../supabase";
import { computeNextDueDate, getDueStatus, type DueStatus } from "../../backflow";
import { fromLocalOr, type LocalReads } from "./source";
import { groupByKey, nestOne, num, numOrNull } from "./rowMap";
import { unwrap, unwrapRows } from "./unwrap";

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
      const res = await supabase
        .from("backflow_devices")
        .select("id, water_authority, serial_number, test_frequency_months, customers(name), sites(name, suburb), backflow_tests(test_date, result)")
        .eq("is_active", true)
        .order("created_at", { ascending: false });
      return computeBackflowRows(unwrapRows(res as never, "listBackflowDevices") as unknown as BackflowDevice[]);
    }
  );
}

// ---------------------------------------------------------------------------
// Device detail (app/backflow/[id].tsx) — device + full test history.
//
// Money-free and synced to EVERY role with the columns below (backflow_devices,
// backflow_tests, customers, sites, profiles streams), so no role gate. The
// screen used to `select("*")`; both paths now name exactly the columns it
// renders, which is what lets the two return identical shapes.
//
// A device absent from the mirror answers from Supabase: one registered
// moments ago may still be in the outbox / the download, and locally-absent is
// not proof of absence.
// ---------------------------------------------------------------------------

export interface BackflowDeviceDetail {
  id: string;
  customer_id: string | null;
  site_id: string | null;
  water_authority: string;
  /** NOT NULL in Postgres (0021). */
  device_type: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  size_mm: number | null;
  location_description: string | null;
  test_frequency_months: number;
  water_meter_number: string | null;
  customers: { name: string } | null;
  sites: { name: string; address_line1: string | null; suburb: string | null; state: string | null; postcode: string | null } | null;
}

export interface BackflowTestSummary {
  id: string;
  test_type: string | null;
  test_date: string;
  result: string;
  tester_name: string | null;
  tested_by: string | null;
  submitted_to_water_authority_at: string | null;
  certificate_storage_path: string | null;
  profiles: { full_name: string } | null;
}

export interface BackflowDeviceWithTests {
  device: BackflowDeviceDetail | null;
  tests: BackflowTestSummary[];
}

export const SQL_GET_BACKFLOW_DEVICE = `
  SELECT d.id, d.customer_id, d.site_id, d.water_authority, d.device_type, d.make, d.model,
         d.serial_number, d.size_mm, d.location_description, d.test_frequency_months,
         d.water_meter_number,
         c.name AS customer_name,
         s.name AS site_name, s.address_line1 AS site_address_line1, s.suburb AS site_suburb,
         s.state AS site_state, s.postcode AS site_postcode
  FROM backflow_devices d
  LEFT JOIN customers c ON c.id = d.customer_id
  LEFT JOIN sites     s ON s.id = d.site_id
  WHERE d.id = ?`;

export const SQL_LIST_DEVICE_TESTS = `
  SELECT t.id, t.test_type, t.test_date, t.result, t.tester_name, t.tested_by,
         t.submitted_to_water_authority_at, t.certificate_storage_path,
         p.full_name AS tester_full_name
  FROM backflow_tests t
  LEFT JOIN profiles p ON p.id = t.tested_by
  WHERE t.device_id = ?
  ORDER BY t.test_date DESC, t.created_at DESC`;

interface RawDeviceDetailRow {
  id: string;
  customer_id: string | null;
  site_id: string | null;
  water_authority: string;
  device_type: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  size_mm: number | string | null;
  location_description: string | null;
  test_frequency_months: number | string | null;
  water_meter_number: string | null;
  customer_name: string | null;
  site_name: string | null;
  site_address_line1: string | null;
  site_suburb: string | null;
  site_state: string | null;
  site_postcode: string | null;
}

interface RawDeviceTestRow {
  id: string;
  test_type: string | null;
  test_date: string;
  result: string;
  tester_name: string | null;
  tested_by: string | null;
  submitted_to_water_authority_at: string | null;
  certificate_storage_path: string | null;
  tester_full_name: string | null;
}

function mapDeviceDetail(r: RawDeviceDetailRow): BackflowDeviceDetail {
  return {
    id: r.id,
    customer_id: r.customer_id ?? null,
    site_id: r.site_id ?? null,
    water_authority: r.water_authority,
    device_type: r.device_type,
    make: r.make ?? null,
    model: r.model ?? null,
    serial_number: r.serial_number ?? null,
    size_mm: numOrNull(r.size_mm),
    location_description: r.location_description ?? null,
    test_frequency_months: num(r.test_frequency_months),
    water_meter_number: r.water_meter_number ?? null,
    // name is NOT NULL on both tables, so a null alias means a null FK — when
    // PostgREST returns a null embed.
    customers: nestOne(r.customer_name, { name: r.customer_name as string }),
    sites: nestOne(r.site_name, {
      name: r.site_name as string,
      address_line1: r.site_address_line1 ?? null,
      suburb: r.site_suburb ?? null,
      state: r.site_state ?? null,
      postcode: r.site_postcode ?? null,
    }),
  };
}

function mapDeviceTest(r: RawDeviceTestRow): BackflowTestSummary {
  return {
    id: r.id,
    test_type: r.test_type ?? null,
    test_date: r.test_date,
    result: r.result,
    tester_name: r.tester_name ?? null,
    tested_by: r.tested_by ?? null,
    submitted_to_water_authority_at: r.submitted_to_water_authority_at ?? null,
    certificate_storage_path: r.certificate_storage_path ?? null,
    profiles: nestOne(r.tester_full_name, { full_name: r.tester_full_name as string }),
  };
}

/** PostgREST rows → the same flat Raw shapes the local SQL returns, so ONE mapper serves both. */
interface RemoteDeviceRow extends Omit<RawDeviceDetailRow, "customer_name" | "site_name" | "site_address_line1" | "site_suburb" | "site_state" | "site_postcode"> {
  customers: { name: string } | null;
  sites: { name: string; address_line1: string | null; suburb: string | null; state: string | null; postcode: string | null } | null;
}
interface RemoteTestRow extends Omit<RawDeviceTestRow, "tester_full_name"> {
  profiles: { full_name: string | null } | null;
}

const flattenRemoteDevice = ({ customers, sites, ...d }: RemoteDeviceRow): RawDeviceDetailRow => ({
  ...d,
  customer_name: customers?.name ?? null,
  site_name: sites?.name ?? null,
  site_address_line1: sites?.address_line1 ?? null,
  site_suburb: sites?.suburb ?? null,
  site_state: sites?.state ?? null,
  site_postcode: sites?.postcode ?? null,
});

const flattenRemoteTest = ({ profiles, ...t }: RemoteTestRow): RawDeviceTestRow => ({
  ...t,
  tester_full_name: profiles?.full_name ?? null,
});

export async function getBackflowDeviceWithTests(id: string): Promise<BackflowDeviceWithTests> {
  const remote = async (): Promise<BackflowDeviceWithTests> => {
    const [deviceRes, testsRes] = await Promise.all([
      supabase
        .from("backflow_devices")
        .select(
          "id, customer_id, site_id, water_authority, device_type, make, model, serial_number, size_mm, location_description, test_frequency_months, water_meter_number, customers(name), sites(name, address_line1, suburb, state, postcode)"
        )
        .eq("id", id)
        .single(),
      supabase
        .from("backflow_tests")
        .select(
          "id, test_type, test_date, result, tester_name, tested_by, submitted_to_water_authority_at, certificate_storage_path, profiles!backflow_tests_tested_by_fkey(full_name)"
        )
        .eq("device_id", id)
        .order("test_date", { ascending: false })
        .order("created_at", { ascending: false }),
    ]);
    // .single() reports "no rows" as PGRST116, which unwrap maps to null — the
    // screen renders "Device not found" for that, and an error for anything else.
    const device = unwrap(deviceRes as never, "getBackflowDeviceWithTests.device") as RemoteDeviceRow | null;
    const tests = unwrapRows(testsRes as never, "getBackflowDeviceWithTests.tests") as RemoteTestRow[];
    return {
      device: device ? mapDeviceDetail(flattenRemoteDevice(device)) : null,
      tests: tests.map((t) => mapDeviceTest(flattenRemoteTest(t))),
    };
  };
  return fromLocalOr(async (db) => {
    const row = await db.getOptional<RawDeviceDetailRow>(SQL_GET_BACKFLOW_DEVICE, [id]);
    if (!row) return remote();
    const tests = await db.getAll<RawDeviceTestRow>(SQL_LIST_DEVICE_TESTS, [id]);
    return { device: mapDeviceDetail(row), tests: tests.map(mapDeviceTest) };
  }, remote);
}
