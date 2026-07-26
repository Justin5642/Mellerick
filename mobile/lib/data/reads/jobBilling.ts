import { supabase } from "../../supabase";
import { computeEquipmentCost, type EquipmentCostInputs } from "../../costing";

export interface JobLineItem {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  unit_price: number;
  total: number;
}
export interface JobExpense {
  id: string;
  supplier_name: string;
  category: string;
  description: string | null;
  amount: number;
  gst_amount: number;
  invoice_number: string | null;
  invoice_date: string | null;
  receipt_storage_path: string | null;
}
export interface JobPOCostCentre {
  id: string;
  name: string;
  allocated_amount: number;
}
export interface JobPO {
  id: string;
  po_number: string;
  client_reference: string | null;
  total_value: number;
  po_cost_centers: JobPOCostCentre[];
}
export interface JobBilling {
  jobNumber: number | null;
  jobTitle: string;
  lineItems: JobLineItem[];
  expenses: JobExpense[];
  purchaseOrders: JobPO[];
}

export async function getJobBilling(jobId: string): Promise<JobBilling | null> {
  const [jobRes, itemsRes, expRes, poRes] = await Promise.all([
    supabase.from("jobs").select("job_number, title").eq("id", jobId).single(),
    supabase.from("job_items").select("id, name, description, quantity, unit_price, total").eq("job_id", jobId).order("created_at"),
    supabase.from("job_expenses").select("id, supplier_name, category, description, amount, gst_amount, invoice_number, invoice_date, receipt_storage_path").eq("job_id", jobId).order("created_at", { ascending: false }),
    supabase.from("purchase_orders").select("id, po_number, client_reference, total_value, po_cost_centers(id, name, allocated_amount)").eq("job_id", jobId),
  ]);
  const job = jobRes.data as { job_number: number | null; title: string } | null;
  if (!job) return null;
  return {
    jobNumber: job.job_number,
    jobTitle: job.title,
    lineItems: (itemsRes.data as unknown as JobLineItem[]) ?? [],
    expenses: (expRes.data as unknown as JobExpense[]) ?? [],
    purchaseOrders: (poRes.data as unknown as JobPO[]) ?? [],
  };
}

// ---- Equipment usage logged against a job (office/admin billing) -------------
// Mirrors the web job "Equipment" tab: log which fleet items were used on the
// job + their hours, priced at each item's computed cost-per-hour so the job's
// equipment cost rolls into profitability. Cost math is the verbatim-ported,
// TDD-locked computeEquipmentCost — no dollar figure is computed on-device for a
// technician (this screen is office/admin-only).

const EQUIP_COST_COLS =
  "purchase_cost, estimated_life_years, insurance_annual, maintenance_annual, registration_annual, other_annual_costs, fuel_cost_per_hour, target_hours_per_year";

export interface JobEquipmentUsage {
  id: string;
  equipment_id: string;
  equipment_name: string;
  category: string;
  usage_date: string;
  hours: number;
  notes: string | null;
  cost_per_hour: number;
}
export interface JobEquipmentOption {
  id: string;
  name: string;
  category: string;
  cost_per_hour: number;
}
export interface JobEquipment {
  usage: JobEquipmentUsage[];
  options: JobEquipmentOption[];
}

export async function getJobEquipment(jobId: string): Promise<JobEquipment> {
  const [usageRes, optRes] = await Promise.all([
    supabase
      .from("equipment_usage_log")
      .select("id, equipment_id, usage_date, hours, notes, equipment:equipment_id(name, category)")
      .eq("job_id", jobId)
      .order("usage_date", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase.from("equipment").select(`id, name, category, ${EQUIP_COST_COLS}`).eq("is_active", true).order("category").order("name"),
  ]);

  // Price each usage row from the ACTIVE equipment map — exactly the web (its
  // equipmentById is built from the active-only options), so usage on a since-
  // deactivated item costs $0 and matches both the web and the mobile Costing
  // screen (jobCosting.ts also filters is_active). The name is still shown from
  // the join (better than the web's "Unknown equipment"; a name is not money).
  type OptRow = { id: string; name: string; category: string } & EquipmentCostInputs;
  const optionRows = (optRes.data as unknown as OptRow[]) ?? [];
  const costById = new Map(optionRows.map((e) => [e.id, computeEquipmentCost(e).costPerHour]));

  type UsageRow = { id: string; equipment_id: string; usage_date: string; hours: number; notes: string | null; equipment: { name: string; category: string } | null };
  const usage: JobEquipmentUsage[] = ((usageRes.data as unknown as UsageRow[]) ?? []).map((r) => ({
    id: r.id,
    equipment_id: r.equipment_id,
    equipment_name: r.equipment?.name ?? "Unknown equipment",
    category: r.equipment?.category ?? "",
    usage_date: r.usage_date,
    hours: Number(r.hours),
    notes: r.notes,
    cost_per_hour: costById.get(r.equipment_id) ?? 0,
  }));

  const options: JobEquipmentOption[] = optionRows.map((e) => ({
    id: e.id,
    name: e.name,
    category: e.category,
    cost_per_hour: costById.get(e.id) ?? 0,
  }));

  return { usage, options };
}

// Short-lived signed URL for a receipt object so the office user can view it.
// Online-only (Storage has no offline story); returns null if unavailable.
export async function getReceiptSignedUrl(storagePath: string): Promise<string | null> {
  const { data } = await supabase.storage.from("job-documents").createSignedUrl(storagePath, 60);
  return data?.signedUrl ?? null;
}
