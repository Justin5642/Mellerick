import { supabase } from "../../supabase";
import { computeEquipmentCost, type EquipmentCostInputs } from "../../costing";
import { fromLocalOr } from "./source";
import { groupByKey, num, numOrNull } from "./rowMap";

// getJobBilling / getJobEquipment are served from the local PowerSync DB when
// available, role-gated to office/admin. getJobCostCentres is ALSO reachable by
// technicians (the Time tab's allocation picker) via the money-stripped
// purchase_orders_public / po_cost_centers_public views — those views have no
// PowerSync counterpart and the base tables are office-only streams, so a
// technician's local DB is EMPTY for them. The role gate forces the technician
// path to Supabase (real cost centres) instead of a silently-blank picker; the
// office/admin local path reads the BASE tables instead of the views.

const ROLES = { roles: ["office", "admin"] as ("office" | "admin")[] };

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
  cost_center_id: string | null;
}

/** A PO cost-centre stage on this job, for allocating time + expenses. */
export interface JobCostCentre {
  id: string;
  name: string;
  code: string | null;
  po_number: string;
}

// Local SQL. Note the FK is po_id, not purchase_order_id (commits c8007ef /
// 4756389), and job_items.total is a Postgres GENERATED column that logical
// replication does not publish — it must be computed, never selected bare.

export const SQL_JOB_COST_CENTRES = `
  SELECT cc.id, cc.name, cc.code, po.po_number
  FROM po_cost_centers cc
  JOIN purchase_orders po ON po.id = cc.po_id
  WHERE po.job_id = ?`;

export const SQL_JOB_BILLING_JOB = `
  SELECT job_number, title FROM jobs WHERE id = ?`;

export const SQL_JOB_BILLING_ITEMS = `
  SELECT id, name, description, quantity, unit_price,
         ROUND(quantity * unit_price, 2) AS total
  FROM job_items WHERE job_id = ? ORDER BY created_at, id`;

export const SQL_JOB_BILLING_EXPENSES = `
  SELECT id, supplier_name, category, description, amount, gst_amount, invoice_number,
         invoice_date, receipt_storage_path, cost_center_id
  FROM job_expenses WHERE job_id = ? ORDER BY created_at DESC`;

export const SQL_JOB_BILLING_POS = `
  SELECT id, po_number, client_reference, total_value
  FROM purchase_orders WHERE job_id = ? ORDER BY created_at`;

export const SQL_JOB_BILLING_PO_COST_CENTERS = `
  SELECT id, po_id, name, allocated_amount
  FROM po_cost_centers WHERE po_id IN (SELECT id FROM purchase_orders WHERE job_id = ?)`;

export const SQL_JOB_EQUIPMENT_USAGE = `
  SELECT u.id, u.equipment_id, u.usage_date, u.hours, u.notes,
         e.name AS equipment_name, e.category AS equipment_category
  FROM equipment_usage_log u LEFT JOIN equipment e ON e.id = u.equipment_id
  WHERE u.job_id = ? ORDER BY u.usage_date DESC, u.created_at DESC`;

export const SQL_JOB_EQUIPMENT_OPTIONS = `
  SELECT id, name, category, purchase_cost, estimated_life_years, insurance_annual,
         maintenance_annual, registration_annual, other_annual_costs,
         fuel_cost_per_hour, target_hours_per_year
  FROM equipment WHERE is_active = 1 ORDER BY category COLLATE NOCASE, name COLLATE NOCASE`;

// SQLite-shaped rows: numerics may arrive as strings (schema drift guard),
// to-one join misses arrive as NULL aliases.
interface RawCostCentreRow {
  id: string;
  name: string;
  code: string | null;
  po_number: string;
}
interface RawJobRow {
  job_number: number | string | null;
  title: string;
}
interface RawJobItemRow {
  id: string;
  name: string;
  description: string | null;
  quantity: number | string | null;
  unit_price: number | string | null;
  total: number | string | null;
}
interface RawJobExpenseRow {
  id: string;
  supplier_name: string;
  category: string;
  description: string | null;
  amount: number | string | null;
  gst_amount: number | string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  receipt_storage_path: string | null;
  cost_center_id: string | null;
}
interface RawJobPORow {
  id: string;
  po_number: string;
  client_reference: string | null;
  total_value: number | string | null;
}
interface RawPOCostCentreRow {
  id: string;
  po_id: string;
  name: string;
  allocated_amount: number | string | null;
}
interface RawEquipUsageRow {
  id: string;
  equipment_id: string;
  usage_date: string;
  hours: number | string | null;
  notes: string | null;
  equipment_name: string | null;
  equipment_category: string | null;
}
interface RawEquipOptionRow {
  id: string;
  name: string;
  category: string;
  purchase_cost: number | string | null;
  estimated_life_years: number | string | null;
  insurance_annual: number | string | null;
  maintenance_annual: number | string | null;
  registration_annual: number | string | null;
  other_annual_costs: number | string | null;
  fuel_cost_per_hour: number | string | null;
  target_hours_per_year: number | string | null;
}

// The job's PO cost-centre stages, flattened across its purchase orders. Shared
// by the Time tab (allocating a time entry) and the Billing tab (allocating an
// expense) so the two can't drift.
export async function getJobCostCentres(jobId: string): Promise<JobCostCentre[]> {
  return fromLocalOr(
    async (db) => {
      const rows = await db.getAll<RawCostCentreRow>(SQL_JOB_COST_CENTRES, [jobId]);
      return rows.map((r) => ({ id: r.id, name: r.name, code: r.code, po_number: r.po_number }));
    },
    async () => {
      // ← unchanged pre-PowerSync Supabase body (byte-identical fallback);
      // ALSO the only path for technicians (role gate above).
      type PoRow = { po_number: string; po_cost_centers_public: { id: string; name: string; code: string | null }[] | null };
      const { data } = await supabase
        .from("purchase_orders_public")
        .select("po_number, po_cost_centers_public(id, name, code)")
        .eq("job_id", jobId);
      return ((data as unknown as PoRow[]) ?? []).flatMap((po) =>
        (po.po_cost_centers_public ?? []).map((cc) => ({ id: cc.id, name: cc.name, code: cc.code, po_number: po.po_number }))
      );
    },
    ROLES
  );
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
  return fromLocalOr(
    async (db) => {
      const [job, itemRows, expenseRows, poRows, ccRows] = await Promise.all([
        db.getOptional<RawJobRow>(SQL_JOB_BILLING_JOB, [jobId]),
        db.getAll<RawJobItemRow>(SQL_JOB_BILLING_ITEMS, [jobId]),
        db.getAll<RawJobExpenseRow>(SQL_JOB_BILLING_EXPENSES, [jobId]),
        db.getAll<RawJobPORow>(SQL_JOB_BILLING_POS, [jobId]),
        db.getAll<RawPOCostCentreRow>(SQL_JOB_BILLING_PO_COST_CENTERS, [jobId]),
      ]);
      if (!job) return null;
      const ccByPo = groupByKey(ccRows, "po_id");
      return {
        jobNumber: numOrNull(job.job_number),
        jobTitle: job.title,
        lineItems: itemRows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          quantity: num(r.quantity),
          unit_price: num(r.unit_price),
          total: num(r.total),
        })),
        expenses: expenseRows.map((r) => ({
          id: r.id,
          supplier_name: r.supplier_name,
          category: r.category,
          description: r.description,
          amount: num(r.amount),
          gst_amount: num(r.gst_amount),
          invoice_number: r.invoice_number,
          invoice_date: r.invoice_date,
          receipt_storage_path: r.receipt_storage_path,
          cost_center_id: r.cost_center_id,
        })),
        purchaseOrders: poRows.map((po) => ({
          id: po.id,
          po_number: po.po_number,
          client_reference: po.client_reference,
          total_value: num(po.total_value),
          // PostgREST returns [] (not null) for an embed with no children.
          po_cost_centers: (ccByPo.get(po.id) ?? []).map((cc) => ({
            id: cc.id,
            name: cc.name,
            allocated_amount: num(cc.allocated_amount),
          })),
        })),
      };
    },
    async () => {
      // ← unchanged pre-PowerSync Supabase body (byte-identical fallback).
      const [jobRes, itemsRes, expRes, poRes] = await Promise.all([
        supabase.from("jobs").select("job_number, title").eq("id", jobId).single(),
        supabase.from("job_items").select("id, name, description, quantity, unit_price, total").eq("job_id", jobId).order("created_at"),
        supabase.from("job_expenses").select("id, supplier_name, category, description, amount, gst_amount, invoice_number, invoice_date, receipt_storage_path, cost_center_id").eq("job_id", jobId).order("created_at", { ascending: false }),
        supabase.from("purchase_orders").select("id, po_number, client_reference, total_value, po_cost_centers(id, name, allocated_amount)").eq("job_id", jobId).order("created_at"),
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
    },
    ROLES
  );
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
  total_cost: number;
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
  return fromLocalOr(
    async (db) => {
      const [usageRows, optionRaw] = await Promise.all([
        db.getAll<RawEquipUsageRow>(SQL_JOB_EQUIPMENT_USAGE, [jobId]),
        db.getAll<RawEquipOptionRow>(SQL_JOB_EQUIPMENT_OPTIONS),
      ]);

      // Same pricing rule as the remote path: the cost map is built from the
      // ACTIVE-only options, so usage on a since-deactivated item costs $0.
      const inputs = optionRaw.map((e) => ({
        id: e.id,
        name: e.name,
        category: e.category,
        purchase_cost: num(e.purchase_cost),
        estimated_life_years: num(e.estimated_life_years),
        insurance_annual: num(e.insurance_annual),
        maintenance_annual: num(e.maintenance_annual),
        registration_annual: num(e.registration_annual),
        other_annual_costs: num(e.other_annual_costs),
        fuel_cost_per_hour: num(e.fuel_cost_per_hour),
        target_hours_per_year: num(e.target_hours_per_year),
      }));
      const costById = new Map(inputs.map((e) => [e.id, computeEquipmentCost(e).costPerHour]));

      const usage: JobEquipmentUsage[] = usageRows.map((r) => {
        const hours = num(r.hours);
        const costPerHour = costById.get(r.equipment_id) ?? 0;
        return {
          id: r.id,
          equipment_id: r.equipment_id,
          equipment_name: r.equipment_name ?? "Unknown equipment",
          category: r.equipment_category ?? "",
          usage_date: r.usage_date,
          hours,
          notes: r.notes,
          cost_per_hour: costPerHour,
          total_cost: hours * costPerHour,
        };
      });

      const options: JobEquipmentOption[] = inputs.map((e) => ({
        id: e.id,
        name: e.name,
        category: e.category,
        cost_per_hour: costById.get(e.id) ?? 0,
      }));

      return { usage, options };
    },
    async () => {
      // ← unchanged pre-PowerSync Supabase body (byte-identical fallback).
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
      const usage: JobEquipmentUsage[] = ((usageRes.data as unknown as UsageRow[]) ?? []).map((r) => {
        const hours = Number(r.hours);
        const costPerHour = costById.get(r.equipment_id) ?? 0;
        return {
          id: r.id,
          equipment_id: r.equipment_id,
          equipment_name: r.equipment?.name ?? "Unknown equipment",
          category: r.equipment?.category ?? "",
          usage_date: r.usage_date,
          hours,
          notes: r.notes,
          cost_per_hour: costPerHour,
          total_cost: hours * costPerHour,
        };
      });

      const options: JobEquipmentOption[] = optionRows.map((e) => ({
        id: e.id,
        name: e.name,
        category: e.category,
        cost_per_hour: costById.get(e.id) ?? 0,
      }));

      return { usage, options };
    },
    ROLES
  );
}

// Short-lived signed URL for a receipt object so the office user can view it.
// Online-only (Storage has no offline story); returns null if unavailable.
export async function getReceiptSignedUrl(storagePath: string): Promise<string | null> {
  const { data } = await supabase.storage.from("job-documents").createSignedUrl(storagePath, 60);
  return data?.signedUrl ?? null;
}
