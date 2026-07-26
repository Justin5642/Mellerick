import { supabase } from "../../supabase";

export interface AssignableStaff {
  id: string;
  full_name: string;
  role: string;
}

// Active staff for the schedule's technician picker. Selects only non-payroll
// columns (id/name/role) so it works for office users too (staff_cost_profiles
// is admin-only). Technicians first, then office/admin, then by name.
export async function listAssignableStaff(): Promise<AssignableStaff[]> {
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .eq("is_active", true)
    .order("full_name");
  const rows = (data as unknown as AssignableStaff[]) ?? [];
  const rank = (r: string) => (r === "technician" ? 0 : r === "office" ? 1 : 2);
  return [...rows].sort((a, b) => rank(a.role) - rank(b.role));
}
