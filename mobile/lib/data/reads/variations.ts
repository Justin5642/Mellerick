import { supabase } from "../../supabase";

// Office/admin read of a job's variations from the BASE table (carries the
// money columns rate/total_amount/admin_notes — office/admin RLS only). The
// technician side reads the rate-stripped job_variations_public view instead
// (see components/job/variations.tsx). Used by the approval/pricing controls.
export interface VariationForApproval {
  id: string;
  variation_type_id: string | null;
  custom_name: string | null;
  description: string | null;
  quantity: number;
  unit: string;
  rate: number | null;
  total_amount: number | null;
  admin_notes: string | null;
  photo_storage_path: string | null;
  status: "auto_approved" | "pending_approval" | "approved" | "rejected";
  created_at: string;
  variation_types: { name: string } | null;
}

export async function getJobVariationsForApproval(jobId: string): Promise<VariationForApproval[]> {
  const { data } = await supabase
    .from("job_variations")
    .select("id, variation_type_id, custom_name, description, quantity, unit, rate, total_amount, admin_notes, photo_storage_path, status, created_at, variation_types(name)")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });
  return (data as unknown as VariationForApproval[]) ?? [];
}
