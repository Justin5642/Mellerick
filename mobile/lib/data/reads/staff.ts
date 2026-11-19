// DELIBERATELY SUPABASE-ONLY — no fromLocalOr / LocalReads path in this module.
// staff_cost_profiles and staff_leave are payroll tables, excluded from the
// PowerSync publication by design (migration 0039) — they never exist
// on-device, so a local read would return empty rows instead of an RLS denial.
// The writes here are already direct/online per DECISIONS D33 and are
// untouched. Pinned by supabaseOnly.test.ts.

import { supabase } from "../../supabase";
import { unwrapRows } from "./unwrap";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

export interface CostProfile {
  hourly_rate: number;
  super_rate: number;
  workers_comp_rate: number;
  leave_loading_rate: number;
  annual_fixed_oncosts: number;
  target_hours_per_week: number;
  charge_out_rate: number | null; // per-employee billing rate override (0026)
}
export interface StaffMember {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  role: string;
  is_active: boolean;
  /** Auto clock on/off override (0082): null = by role. */
  auto_clock?: boolean | null;
  staff_cost_profiles: CostProfile | null;
}

export async function listStaff(): Promise<StaffMember[]> {
  // The embed MUST name the foreign key. staff_cost_profiles has two FKs to
  // profiles — staff_id (whose cost profile this is) and updated_by (who last
  // edited it) — so PostgREST cannot choose and fails the whole query with
  // PGRST201. updated_by was added later, which broke this screen silently:
  // the error was swallowed and it rendered "No staff." ever since.
  //
  // The error was previously destructured away, so a failed query returned []
  // and the screen rendered "No staff." — indistinguishable from there being
  // none. That is how this read appeared to work while returning nothing on an
  // admin account that plainly had staff.
  const res = await supabase
    .from("profiles")
    .select("id, full_name, email, phone, role, is_active, auto_clock, staff_cost_profiles!staff_cost_profiles_staff_id_fkey(hourly_rate, super_rate, workers_comp_rate, leave_loading_rate, annual_fixed_oncosts, target_hours_per_week, charge_out_rate)")
    .order("full_name");
  return unwrapRows(res as never, "listStaff") as unknown as StaffMember[];
}

// Staff writes are DIRECT (online-only) — staff_cost_profiles has a staff_id PK
// (not the id-PK the generic outbox assumes), and this is an admin/online task.
// See DECISIONS D33.
export async function saveStaff(input: {
  id: string;
  role: string;
  isActive: boolean;
  phone: string | null;
  cost: CostProfile;
}): Promise<void> {
  const profileRes = await supabase.from("profiles").update({ role: input.role, phone: input.phone }).eq("id", input.id);
  if (profileRes.error) throw new Error(`profile: ${profileRes.error.message}`);
  // Active/inactive goes through the web API, not a direct write: deactivating
  // must also ban the person's login (app/api/staff/set-active), which needs the
  // service role. Idempotent, so it is safe to send on every save.
  await setStaffActive(input.id, input.isActive);
  const costRes = await supabase.from("staff_cost_profiles").upsert(
    {
      staff_id: input.id,
      hourly_rate: input.cost.hourly_rate,
      super_rate: input.cost.super_rate,
      workers_comp_rate: input.cost.workers_comp_rate,
      leave_loading_rate: input.cost.leave_loading_rate,
      annual_fixed_oncosts: input.cost.annual_fixed_oncosts,
      target_hours_per_week: input.cost.target_hours_per_week,
      charge_out_rate: input.cost.charge_out_rate,
    },
    { onConflict: "staff_id" }
  );
  if (costRes.error) throw new Error(`cost profile: ${costRes.error.message}`);
}

async function setStaffActive(id: string, active: boolean): Promise<void> {
  if (!API_BASE_URL) throw new Error("active: app isn't configured to reach the office server");
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(`active: ${error.message}`);
  const token = data.session?.access_token;
  if (!token) throw new Error("active: session expired");
  const res = await fetch(`${API_BASE_URL}/api/staff/set-active`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id, active }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`active: ${body?.error ?? `HTTP ${res.status}`}`);
  }
}

// ---- Staff leave log (admin-only; direct writes per D33) ----

// The same five types as the web Leave Log (0014's check; 0112's schedule colours).
export type LeaveType = "sick" | "annual" | "public_holiday" | "long_service" | "other";
export const LEAVE_TYPES: LeaveType[] = ["sick", "annual", "public_holiday", "long_service", "other"];
export interface LeaveEntry {
  id: string;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  hours: number;
  notes: string | null;
  /** Part day (0112): Melbourne wall-clock "HH:MM[:SS]", both or neither. */
  start_time?: string | null;
  end_time?: string | null;
}

const LEAVE_COLUMNS = "id, leave_type, start_date, end_date, hours, notes";
const isMissingColumn = (code: string | undefined) => code === "42703" || code === "PGRST204";

export async function listLeave(staffId: string): Promise<LeaveEntry[]> {
  const query = (cols: string) =>
    supabase.from("staff_leave").select(cols).eq("staff_id", staffId).order("start_date", { ascending: false });
  // Part-day times (0112); a database without them still lists the leave.
  let res = await query(`${LEAVE_COLUMNS}, start_time, end_time`);
  if (res.error && isMissingColumn(res.error.code)) res = await query(LEAVE_COLUMNS);
  return unwrapRows(res as never, "listLeave") as unknown as LeaveEntry[];
}

/** Thrown when part-day times were given but the database has no columns for them (before 0112). */
export class LeaveTimesUnavailable extends Error {
  constructor() {
    super("Part-day times aren't switched on yet (0112) — log it without From/To.");
    this.name = "LeaveTimesUnavailable";
  }
}

export async function addLeave(input: {
  staffId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  hours: number;
  notes: string | null;
  /** Both or neither (validateLeaveTimes in lib/staffLeave.ts). */
  startTime?: string | null;
  endTime?: string | null;
}): Promise<void> {
  const { error } = await supabase.from("staff_leave").insert({
    staff_id: input.staffId,
    leave_type: input.leaveType,
    start_date: input.startDate,
    end_date: input.endDate,
    hours: input.hours,
    notes: input.notes,
    // Only sent when given, so leave still logs on a database without 0112.
    ...(input.startTime && input.endTime ? { start_time: input.startTime, end_time: input.endTime } : {}),
  });
  if (error) {
    if (input.startTime && isMissingColumn(error.code)) throw new LeaveTimesUnavailable();
    throw new Error(error.message);
  }
}

export async function removeLeave(id: string): Promise<void> {
  const { error } = await supabase.from("staff_leave").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
