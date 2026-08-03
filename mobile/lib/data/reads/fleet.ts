import { supabase } from "../../supabase";
import { computeEquipmentCost } from "../../costing";
import { fromLocalOr, type RouteOptions } from "./source";
import { nestOne, num } from "./rowMap";
import { unwrap, unwrapRows } from "./unwrap";

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

// Fleet screens are office/admin surfaces; the equipment tables ride the
// office-only streams, so a technician's local DB is empty. The role gate
// routes technicians to Supabase, where RLS gives a loud denial instead of a
// silently-empty local list.
const FLEET_ROLES: RouteOptions = { roles: ["office", "admin"] };

// listEquipment / listInactiveEquipment / getEquipment share this projection:
// the PostgREST to-one embed (assigned_profile) becomes a LEFT JOIN alias,
// re-nested in mapEquipment.
const EQUIPMENT_PROJECTION = `
  SELECT e.id, e.name, e.category, e.registration, e.purchase_cost, e.purchase_date,
         e.estimated_life_years, e.insurance_annual, e.maintenance_annual,
         e.registration_annual, e.other_annual_costs, e.fuel_cost_per_hour,
         e.target_hours_per_year, e.notes, e.assigned_to,
         p.full_name AS assigned_profile_name
  FROM equipment e LEFT JOIN profiles p ON p.id = e.assigned_to`;

export const SQL_LIST_EQUIPMENT = `${EQUIPMENT_PROJECTION}
  WHERE e.is_active = ?
  ORDER BY e.category COLLATE NOCASE, e.name COLLATE NOCASE`;

export const SQL_GET_EQUIPMENT = `${EQUIPMENT_PROJECTION}
  WHERE e.id = ?`;

interface RawEquipmentRow {
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
  assigned_profile_name: string | null;
}

function mapEquipment(r: RawEquipmentRow): Equipment {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    registration: r.registration,
    purchase_cost: num(r.purchase_cost),
    purchase_date: r.purchase_date,
    estimated_life_years: num(r.estimated_life_years),
    insurance_annual: num(r.insurance_annual),
    maintenance_annual: num(r.maintenance_annual),
    registration_annual: num(r.registration_annual),
    other_annual_costs: num(r.other_annual_costs),
    fuel_cost_per_hour: num(r.fuel_cost_per_hour),
    target_hours_per_year: num(r.target_hours_per_year),
    notes: r.notes,
    assigned_to: r.assigned_to,
    assigned_profile: nestOne(r.assigned_to, { full_name: r.assigned_profile_name as string }),
  };
}

export async function listEquipment(): Promise<Equipment[]> {
  return fromLocalOr(
    async (db) => (await db.getAll<RawEquipmentRow>(SQL_LIST_EQUIPMENT, [1])).map(mapEquipment),
    async () => {
      const res = await supabase.from("equipment").select(SELECT).eq("is_active", true).order("category").order("name");
      return unwrapRows(res as never, "listEquipment") as unknown as Equipment[];
    },
    FLEET_ROLES
  );
}

// Deactivated fleet items — surfaced behind a "show inactive" toggle so they can
// be reactivated (mirrors the Pricing inactive flow; the web fleet list shows
// active + inactive together).
export async function listInactiveEquipment(): Promise<Equipment[]> {
  return fromLocalOr(
    async (db) => (await db.getAll<RawEquipmentRow>(SQL_LIST_EQUIPMENT, [0])).map(mapEquipment),
    async () => {
      const res = await supabase.from("equipment").select(SELECT).eq("is_active", false).order("category").order("name");
      return unwrapRows(res as never, "listInactiveEquipment") as unknown as Equipment[];
    },
    FLEET_ROLES
  );
}

export async function getEquipment(id: string): Promise<Equipment | null> {
  return fromLocalOr(
    async (db) => {
      const row = await db.getOptional<RawEquipmentRow>(SQL_GET_EQUIPMENT, [id]);
      return row ? mapEquipment(row) : null;
    },
    async () => {
      const res = await supabase.from("equipment").select(SELECT).eq("id", id).single();
      return unwrap(res as never, "getEquipment") as unknown as Equipment | null;
    },
    FLEET_ROLES
  );
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

export const SQL_LIST_EQUIPMENT_EXPENSES = `
  SELECT id, category, supplier_name, description, invoice_number, expense_date,
         amount, gst_amount, receipt_storage_path
  FROM equipment_expenses WHERE equipment_id = ?
  ORDER BY expense_date DESC, created_at DESC`;

interface RawEquipmentExpenseRow {
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

function mapEquipmentExpense(r: RawEquipmentExpenseRow): EquipmentExpense {
  return {
    id: r.id,
    category: r.category,
    supplier_name: r.supplier_name,
    description: r.description,
    invoice_number: r.invoice_number,
    expense_date: r.expense_date,
    amount: num(r.amount),
    gst_amount: num(r.gst_amount),
    receipt_storage_path: r.receipt_storage_path,
  };
}

export async function listEquipmentExpenses(equipmentId: string): Promise<EquipmentExpense[]> {
  return fromLocalOr(
    async (db) =>
      (await db.getAll<RawEquipmentExpenseRow>(SQL_LIST_EQUIPMENT_EXPENSES, [equipmentId])).map(mapEquipmentExpense),
    async () => {
      const res = await supabase
        .from("equipment_expenses")
        .select("id, category, supplier_name, description, invoice_number, expense_date, amount, gst_amount, receipt_storage_path")
        .eq("equipment_id", equipmentId)
        .order("expense_date", { ascending: false })
        .order("created_at", { ascending: false });
      return unwrapRows(res as never, "listEquipmentExpenses") as unknown as EquipmentExpense[];
    },
    FLEET_ROLES
  );
}

export interface EquipmentUsage {
  id: string;
  usage_date: string;
  hours: number;
  notes: string | null;
  job_id: string | null;
}

export const SQL_LIST_EQUIPMENT_USAGE = `
  SELECT id, usage_date, hours, notes, job_id
  FROM equipment_usage_log WHERE equipment_id = ?
  ORDER BY usage_date DESC, created_at DESC`;

interface RawEquipmentUsageRow {
  id: string;
  usage_date: string;
  hours: number;
  notes: string | null;
  job_id: string | null;
}

function mapEquipmentUsage(r: RawEquipmentUsageRow): EquipmentUsage {
  return {
    id: r.id,
    usage_date: r.usage_date,
    hours: num(r.hours),
    notes: r.notes,
    job_id: r.job_id,
  };
}

export async function listEquipmentUsage(equipmentId: string): Promise<EquipmentUsage[]> {
  return fromLocalOr(
    async (db) =>
      (await db.getAll<RawEquipmentUsageRow>(SQL_LIST_EQUIPMENT_USAGE, [equipmentId])).map(mapEquipmentUsage),
    async () => {
      const res = await supabase
        .from("equipment_usage_log")
        .select("id, usage_date, hours, notes, job_id")
        .eq("equipment_id", equipmentId)
        .order("usage_date", { ascending: false })
        .order("created_at", { ascending: false });
      return unwrapRows(res as never, "listEquipmentUsage") as unknown as EquipmentUsage[];
    },
    FLEET_ROLES
  );
}

// Short-lived signed URL for an equipment-expense receipt (equipment-documents
// bucket). Online-only; null when Storage hands back no URL — but a Storage
// ERROR now throws instead of posing as "no URL" (matches getReceiptSignedUrl).
// Supabase-only: signed URLs are network-only by nature — no local path.
export async function getEquipmentReceiptSignedUrl(storagePath: string): Promise<string | null> {
  const res = await supabase.storage.from("equipment-documents").createSignedUrl(storagePath, 60);
  const data = unwrap(res as never, "getEquipmentReceiptSignedUrl") as { signedUrl: string } | null;
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

// Supabase-only: equipment_documents is not in the PowerSync publication, so a
// local read would silently return [] — never serve it from the device.
export async function listEquipmentDocuments(equipmentId: string): Promise<EquipmentDocument[]> {
  const res = await supabase
    .from("equipment_documents")
    .select("id, storage_path, file_name, file_size, file_type, created_at, profiles:uploaded_by(full_name)")
    .eq("equipment_id", equipmentId)
    .order("created_at", { ascending: false });
  return unwrapRows(res as never, "listEquipmentDocuments") as unknown as EquipmentDocument[];
}

// Supabase-only: signed URLs are network-only by nature — no local path.
export async function getEquipmentDocumentSignedUrl(storagePath: string): Promise<string | null> {
  const res = await supabase.storage.from("equipment-documents").createSignedUrl(storagePath, 300);
  const data = unwrap(res as never, "getEquipmentDocumentSignedUrl") as { signedUrl: string } | null;
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
