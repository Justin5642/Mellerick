import { supabase } from "../../supabase";
import { fromLocalOr } from "./source";

export interface AssignableStaff {
  id: string;
  full_name: string;
  role: string;
}

// Local (PowerSync) equivalent of the Supabase query below. `is_active`
// reaches the device via profiles stream v2. COLLATE NOCASE approximates
// PG's case-insensitive collation; `full_name` is NOT NULL, so no
// `IS NULL` ordering prefix is needed.
export const SQL_LIST_ASSIGNABLE_STAFF = `
  SELECT id, full_name, role FROM profiles WHERE is_active = 1
  ORDER BY full_name COLLATE NOCASE`;

// Active staff for the schedule's technician picker. Selects only non-payroll
// columns (id/name/role) so it works for office users too (staff_cost_profiles
// is admin-only). Technicians first, then office/admin, then by name.
export async function listAssignableStaff(): Promise<AssignableStaff[]> {
  return fromLocalOr(
    async (db) => {
      const rows = await db.getAll<AssignableStaff>(SQL_LIST_ASSIGNABLE_STAFF, []);
      // Same role re-sort as the Supabase path below, unchanged: the SQL's
      // full_name order is the tiebreak, role rank is the primary key.
      const rank = (r: string) => (r === "technician" ? 0 : r === "office" ? 1 : 2);
      return [...rows].sort((a, b) => rank(a.role) - rank(b.role) || a.full_name.localeCompare(b.full_name));
    },
    async () => {
      // ← unchanged pre-PowerSync Supabase body (byte-identical fallback).
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, role")
        .eq("is_active", true)
        .order("full_name");
      const rows = (data as unknown as AssignableStaff[]) ?? [];
      const rank = (r: string) => (r === "technician" ? 0 : r === "office" ? 1 : 2);
      // Stable: role first, then alphabetical (the query's full_name order isn't
      // preserved by a role-only sort).
      return [...rows].sort((a, b) => rank(a.role) - rank(b.role) || a.full_name.localeCompare(b.full_name));
    },
    { roles: ["office", "admin"] }
  );
}
