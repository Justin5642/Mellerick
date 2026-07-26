import { supabase } from "../../supabase";
import { computeEquipmentCost } from "../../costing";

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

// Deactivated fleet items — surfaced behind a "show inactive" toggle so they can
// be reactivated (mirrors the Pricing inactive flow; the web fleet list shows
// active + inactive together).
export async function listInactiveEquipment(): Promise<Equipment[]> {
  const { data } = await supabase.from("equipment").select(SELECT).eq("is_active", false).order("category").order("name");
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

export interface EquipmentUsage {
  id: string;
  usage_date: string;
  hours: number;
  notes: string | null;
  job_id: string | null;
}

export async function listEquipmentUsage(equipmentId: string): Promise<EquipmentUsage[]> {
  const { data } = await supabase
    .from("equipment_usage_log")
    .select("id, usage_date, hours, notes, job_id")
    .eq("equipment_id", equipmentId)
    .order("usage_date", { ascending: false })
    .order("created_at", { ascending: false });
  return (data as unknown as EquipmentUsage[]) ?? [];
}

// Short-lived signed URL for an equipment-expense receipt (equipment-documents
// bucket). Online-only; null if unavailable.
export async function getEquipmentReceiptSignedUrl(storagePath: string): Promise<string | null> {
  const { data } = await supabase.storage.from("equipment-documents").createSignedUrl(storagePath, 60);
  return data?.signedUrl ?? null;
}

// Files attached to a piece of equipment — registration/insurance/compliance
// certs, service invoices (migration 0023). Mobile is view/open-only, matching
// the job-documents story (upload stays a web action); the private
// equipment-documents bucket is opened via a short-lived signed URL.
export interface EquipmentDocument {
  id: string;
  storage_path: string;
  file_name: string;
  file_size: number | null;
  file_type: string | null;
  created_at: string;
  profiles: { full_name: string } | null;
}

export async function listEquipmentDocuments(equipmentId: string): Promise<EquipmentDocument[]> {
  const { data } = await supabase
    .from("equipment_documents")
    .select("id, storage_path, file_name, file_size, file_type, created_at, profiles:uploaded_by(full_name)")
    .eq("equipment_id", equipmentId)
    .order("created_at", { ascending: false });
  return (data as unknown as EquipmentDocument[]) ?? [];
}

export async function getEquipmentDocumentSignedUrl(storagePath: string): Promise<string | null> {
  const { data } = await supabase.storage.from("equipment-documents").createSignedUrl(storagePath, 300);
  return data?.signedUrl ?? null;
}

// The web's equipment cost model. Delegates to lib/costing.ts (the verbatim,
// TDD-locked port of the web's lib/equipment-cost.ts) instead of re-deriving the
// arithmetic here. The two were algebraically equivalent, but keeping a second
// copy of a MONEY formula is exactly how drift starts — one source of truth means
// the Fleet list, the Fleet detail screen, job costing and the web can't diverge
// (Q14).
export function hourlyRate(e: Equipment): number {
  return computeEquipmentCost(e).costPerHour;
}
