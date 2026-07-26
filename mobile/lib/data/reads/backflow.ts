import { supabase } from "../../supabase";
import { computeNextDueDate, getDueStatus, type DueStatus } from "../../backflow";

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

export async function listBackflowDevices(): Promise<BackflowRow[]> {
  const { data } = await supabase
    .from("backflow_devices")
    .select("id, water_authority, serial_number, test_frequency_months, customers(name), sites(name, suburb), backflow_tests(test_date, result)")
    .eq("is_active", true)
    .order("created_at", { ascending: false });
  return computeBackflowRows((data as unknown as BackflowDevice[]) ?? []);
}
