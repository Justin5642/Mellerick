import { supabase } from "../../supabase";

export interface CostProfile {
  hourly_rate: number;
  super_rate: number;
  workers_comp_rate: number;
  leave_loading_rate: number;
  annual_fixed_oncosts: number;
  target_hours_per_week: number;
}
export interface StaffMember {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  role: string;
  is_active: boolean;
  staff_cost_profiles: CostProfile | null;
}

export async function listStaff(): Promise<StaffMember[]> {
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, email, phone, role, is_active, staff_cost_profiles(hourly_rate, super_rate, workers_comp_rate, leave_loading_rate, annual_fixed_oncosts, target_hours_per_week)")
    .order("full_name");
  return (data as unknown as StaffMember[]) ?? [];
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
  await supabase.from("profiles").update({ role: input.role, is_active: input.isActive, phone: input.phone }).eq("id", input.id);
  await supabase.from("staff_cost_profiles").upsert(
    {
      staff_id: input.id,
      hourly_rate: input.cost.hourly_rate,
      super_rate: input.cost.super_rate,
      workers_comp_rate: input.cost.workers_comp_rate,
      leave_loading_rate: input.cost.leave_loading_rate,
      annual_fixed_oncosts: input.cost.annual_fixed_oncosts,
      target_hours_per_week: input.cost.target_hours_per_week,
    },
    { onConflict: "staff_id" }
  );
}
