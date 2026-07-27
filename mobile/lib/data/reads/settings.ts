import { supabase } from "../../supabase";

export interface VariationType {
  id: string;
  name: string;
  unit: string;
  rate: number;
  auto_approve: boolean;
  is_active: boolean;
}

// All variation types (active + inactive) for the admin Settings management
// section. The job-variation picker itself filters to is_active elsewhere.
export async function listVariationTypes(): Promise<VariationType[]> {
  const { data } = await supabase
    .from("variation_types")
    .select("id, name, unit, rate, auto_approve, is_active")
    .order("is_active", { ascending: false })
    .order("name");
  return (data as unknown as VariationType[]) ?? [];
}

export interface CostCentreTemplate {
  id: string;
  group_name: string;
  name: string;
  code: string | null;
  is_active: boolean;
}

export async function listCostCentreTemplates(): Promise<CostCentreTemplate[]> {
  const { data } = await supabase
    .from("cost_center_templates")
    .select("id, group_name, name, code, is_active")
    .order("group_name")
    .order("sort_order")
    .order("name");
  return (data as unknown as CostCentreTemplate[]) ?? [];
}
