import { supabase } from "../../supabase";

export interface Equipment {
  id: string;
  name: string;
  category: string;
  registration: string | null;
  purchase_cost: number;
  purchase_date: string | null;
  estimated_life_years: number;
  insurance_annual: number;
  maintenance_annual: number;
  registration_annual: number;
  other_annual_costs: number;
  fuel_cost_per_hour: number;
  target_hours_per_year: number;
  notes: string | null;
  assigned_to: string | null;
  assigned_profile: { full_name: string } | null;
}

const SELECT =
  "id, name, category, registration, purchase_cost, purchase_date, estimated_life_years, insurance_annual, maintenance_annual, registration_annual, other_annual_costs, fuel_cost_per_hour, target_hours_per_year, notes, assigned_to, assigned_profile:profiles!equipment_assigned_to_fkey(full_name)";

export async function listEquipment(): Promise<Equipment[]> {
  const { data } = await supabase.from("equipment").select(SELECT).eq("is_active", true).order("category").order("name");
  return (data as unknown as Equipment[]) ?? [];
}

export async function getEquipment(id: string): Promise<Equipment | null> {
  const { data } = await supabase.from("equipment").select(SELECT).eq("id", id).single();
  return (data as unknown as Equipment) ?? null;
}

export interface EquipmentExpense {
  id: string;
  category: string;
  supplier_name: string | null;
  description: string | null;
  invoice_number: string | null;
  expense_date: string | null;
  amount: number;
  gst_amount: number;
  receipt_storage_path: string | null;
}

export async function listEquipmentExpenses(equipmentId: string): Promise<EquipmentExpense[]> {
  const { data } = await supabase
    .from("equipment_expenses")
    .select("id, category, supplier_name, description, invoice_number, expense_date, amount, gst_amount, receipt_storage_path")
    .eq("equipment_id", equipmentId)
    .order("expense_date", { ascending: false })
    .order("created_at", { ascending: false });
  return (data as unknown as EquipmentExpense[]) ?? [];
}

// Short-lived signed URL for an equipment-expense receipt (equipment-documents
// bucket). Online-only; null if unavailable.
export async function getEquipmentReceiptSignedUrl(storagePath: string): Promise<string | null> {
  const { data } = await supabase.storage.from("equipment-documents").createSignedUrl(storagePath, 60);
  return data?.signedUrl ?? null;
}

// The web's equipment cost model: total annual cost / target hours + fuel/hr.
// Depreciation = purchase_cost / estimated_life_years.
export function hourlyRate(e: Equipment): number {
  // Match the web: with no target hours there's no meaningful per-hour rate — the
  // whole expression is 0 (fuel is NOT added on top when hours is 0).
  if (Number(e.target_hours_per_year) <= 0) return 0;
  const depreciation = e.estimated_life_years > 0 ? Number(e.purchase_cost) / Number(e.estimated_life_years) : 0;
  const annual = depreciation + Number(e.insurance_annual) + Number(e.maintenance_annual) + Number(e.registration_annual) + Number(e.other_annual_costs);
  return annual / Number(e.target_hours_per_year) + Number(e.fuel_cost_per_hour);
}
