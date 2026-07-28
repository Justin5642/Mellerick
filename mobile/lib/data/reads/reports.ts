import { supabase } from "../../supabase";
import { fromLocalOr } from "./source";
import { num, numOrNull } from "./rowMap";
import { topCustomersBySpend, revenueByMonth, jobsByStaff, type InvoiceRow, type JobStaffRow } from "../../reportsAnalytics";
import { dateKeyInBusinessTZ } from "../../date";
import { computeStaffEfficiency, type StaffEffProfile, type StaffEffRow, type StaffEffInput } from "../../staffEfficiency";
import { computeEquipmentUtilization, type EquipUtilRow, type EquipUtilInput } from "../../equipmentUtilization";

export interface ReportSummary {
  revenuePaid: number;
  outstanding: number;
  totalOverdue: number;
  quotesAccepted: number;
  quotesDeclined: number;
  quotesTotal: number;
  acceptedValue: number;
  quotesByStatus: { status: string; count: number }[];
  jobsByStatus: { status: string; count: number }[];
  activeJobs: number;
}

// Includes on_hold — the web reports dashboard counts all six job statuses, so
// omitting it would drop that whole bucket and the per-status counts wouldn't
// sum to the job total.
const JOB_STATUSES = ["pending", "scheduled", "in_progress", "on_hold", "completed", "cancelled"] as const;
// The five quote statuses the web reports dashboard buckets by.
const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined", "expired"] as const;

// Local (PowerSync) equivalents of the Supabase queries below. The six
// `count: "exact", head: true` per-status job queries collapse into one
// GROUP BY — see the mapper note on zero-filling.
export const SQL_REPORT_PAID_INVOICES = `
  SELECT total FROM invoices WHERE status = 'paid'`;

export const SQL_REPORT_OUTSTANDING_INVOICES = `
  SELECT total, status FROM invoices WHERE status IN ('sent','overdue')`;

export const SQL_REPORT_QUOTES = `
  SELECT status, total FROM quotes`;

export const SQL_REPORT_JOB_COUNTS = `
  SELECT status, COUNT(*) AS c FROM jobs
  WHERE status IN ('pending','scheduled','in_progress','on_hold','completed','cancelled')
  GROUP BY status`;

/** Row shapes as the device SQLite returns them (numerics may arrive as strings). */
interface RawTotalRow {
  total: number | string | null;
}
interface RawStatusTotalRow {
  total: number | string | null;
  status: string;
}
interface RawJobCountRow {
  status: string;
  c: number | string;
}

export async function getReportSummary(): Promise<ReportSummary> {
  return fromLocalOr(
    async (db) => {
      const [paidRows, outstandingRows, quoteRows, jobCountRows] = await Promise.all([
        db.getAll<RawTotalRow>(SQL_REPORT_PAID_INVOICES),
        db.getAll<RawStatusTotalRow>(SQL_REPORT_OUTSTANDING_INVOICES),
        db.getAll<RawStatusTotalRow>(SQL_REPORT_QUOTES),
        db.getAll<RawJobCountRow>(SQL_REPORT_JOB_COUNTS),
      ]);
      const sum = (rows: RawTotalRow[]) => rows.reduce((s, r) => s + num(r.total), 0);
      // GROUP BY omits empty buckets; PostgREST's per-status head-count query
      // does not. Re-expand to ALL six statuses, in declared order, zero-filled
      // — otherwise a status with no jobs vanishes from the dashboard chart.
      const countByStatus = new Map(jobCountRows.map((r) => [r.status, num(r.c)]));
      const jobsByStatus = JOB_STATUSES.map((status) => ({ status, count: countByStatus.get(status) ?? 0 }));
      const activeJobs = jobsByStatus.filter((j) => ["pending", "scheduled", "in_progress"].includes(j.status)).reduce((s, j) => s + j.count, 0);
      return {
        revenuePaid: sum(paidRows),
        outstanding: sum(outstandingRows),
        // Overdue subset only — matches the web reports headline (Σ overdue invoices).
        totalOverdue: sum(outstandingRows.filter((r) => r.status === "overdue")),
        quotesAccepted: quoteRows.filter((q) => q.status === "accepted").length,
        quotesDeclined: quoteRows.filter((q) => q.status === "declined").length,
        quotesTotal: quoteRows.length,
        // Σ accepted-quote totals — matches the web reports headline.
        acceptedValue: sum(quoteRows.filter((q) => q.status === "accepted")),
        quotesByStatus: QUOTE_STATUSES.map((status) => ({ status, count: quoteRows.filter((q) => q.status === status).length })),
        jobsByStatus,
        activeJobs,
      };
    },
    async () => {
      // ← unchanged pre-PowerSync Supabase body (byte-identical fallback).
      const jobCountQueries = JOB_STATUSES.map((s) =>
        supabase.from("jobs").select("*", { count: "exact", head: true }).eq("status", s)
      );
      const [paidRes, outstandingRes, quotesRes, ...jobCounts] = await Promise.all([
        supabase.from("invoices").select("total").eq("status", "paid"),
        supabase.from("invoices").select("total, status").in("status", ["sent", "overdue"]),
        supabase.from("quotes").select("status, total"),
        ...jobCountQueries,
      ]);

      const sum = (rows: { total: number | null }[] | null) => (rows ?? []).reduce((s, r) => s + Number(r.total ?? 0), 0);
      const outstandingRows = (outstandingRes.data as { total: number | null; status: string }[] | null) ?? [];
      const quotes = (quotesRes.data as { status: string; total: number | null }[] | null) ?? [];
      const jobsByStatus = JOB_STATUSES.map((status, i) => ({ status, count: jobCounts[i].count ?? 0 }));
      const activeJobs = jobsByStatus.filter((j) => ["pending", "scheduled", "in_progress"].includes(j.status)).reduce((s, j) => s + j.count, 0);

      return {
        revenuePaid: sum(paidRes.data as { total: number | null }[] | null),
        outstanding: sum(outstandingRows),
        // Overdue subset only — matches the web reports headline (Σ overdue invoices).
        totalOverdue: sum(outstandingRows.filter((r) => r.status === "overdue")),
        quotesAccepted: quotes.filter((q) => q.status === "accepted").length,
        quotesDeclined: quotes.filter((q) => q.status === "declined").length,
        quotesTotal: quotes.length,
        // Σ accepted-quote totals — matches the web reports headline.
        acceptedValue: sum(quotes.filter((q) => q.status === "accepted")),
        quotesByStatus: QUOTE_STATUSES.map((status) => ({ status, count: quotes.filter((q) => q.status === status).length })),
        jobsByStatus,
        activeJobs,
      };
    },
    { roles: ["office", "admin"] }
  );
}

export interface ReportAnalytics {
  topCustomers: { customerId: string; name: string; total: number }[];
  revenueByMonth: { monthKey: string; paid: number; outstanding: number }[];
  jobsByStaff: { name: string; completed: number; total: number; rate: number }[];
}

// The last `n` calendar-month keys ("YYYY-MM"), oldest→newest, ending this month
// in BUSINESS (Melbourne) time — so the window matches the web regardless of the
// device timezone. Months are stepped via a UTC-anchored date (DST-safe).
function lastNMonthKeys(n: number): string[] {
  const [y, m] = dateKeyInBusinessTZ(new Date()).slice(0, 7).split("-").map(Number);
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return keys;
}

// Admin-only staff cost & efficiency over the last 12 months. Mirrors the web
// Reports page. staff_cost_profiles / staff_leave are payroll-sensitive (RLS
// admin-only) — the Reports screen only calls this for admins.
//
// SUPABASE-ONLY, deliberately: staff_cost_profiles and staff_leave are excluded
// from the PowerSync publication (migration 0039), so a local read would see
// empty tables and return silently-wrong payroll numbers instead of an RLS
// denial. No fromLocalOr here — this must always hit the network.
export async function getStaffEfficiency(): Promise<StaffEffRow[]> {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const cutoffIso = cutoff.toISOString();
  const cutoffDate = cutoffIso.slice(0, 10);

  const [profilesRes, leaveRes, workRes, equipRes, nameRes] = await Promise.all([
    supabase.from("staff_cost_profiles").select("*"),
    supabase.from("staff_leave").select("staff_id, leave_type, hours, start_date").gte("start_date", cutoffDate),
    supabase.from("time_entries").select("staff_id, hours").eq("entry_type", "work").gte("clock_in", cutoffIso).not("hours", "is", null),
    supabase.from("equipment").select("*").eq("is_active", true),
    supabase.from("profiles").select("id, full_name"),
  ]);

  type NameRow = { id: string; full_name: string };
  const nameByStaff: Record<string, string> = {};
  for (const p of (nameRes.data as unknown as NameRow[]) ?? []) nameByStaff[p.id] = p.full_name;

  const input: StaffEffInput = {
    profiles: (profilesRes.data as unknown as StaffEffProfile[]) ?? [],
    workEntries: (workRes.data as unknown as { staff_id: string; hours: number | null }[]) ?? [],
    leaveEntries: (leaveRes.data as unknown as { staff_id: string; leave_type: string; hours: number | null }[]) ?? [],
    equipment: (equipRes.data as unknown as StaffEffInput["equipment"]) ?? [],
    nameByStaff,
  };
  return computeStaffEfficiency(input);
}

export const SQL_EQUIPMENT_UTILIZATION_EQUIPMENT = `
  SELECT id, name, purchase_cost, estimated_life_years, insurance_annual, maintenance_annual,
         registration_annual, other_annual_costs, fuel_cost_per_hour, target_hours_per_year
  FROM equipment WHERE is_active = 1`;

export const SQL_EQUIPMENT_UTILIZATION_USAGE = `
  SELECT equipment_id, hours, usage_date FROM equipment_usage_log WHERE usage_date >= ?`;

interface RawEquipCostRow {
  id: string;
  name: string;
  purchase_cost: number | string | null;
  estimated_life_years: number | string | null;
  insurance_annual: number | string | null;
  maintenance_annual: number | string | null;
  registration_annual: number | string | null;
  other_annual_costs: number | string | null;
  fuel_cost_per_hour: number | string | null;
  target_hours_per_year: number | string | null;
}
interface RawUsageRow {
  equipment_id: string;
  hours: number | string | null;
  usage_date: string;
}

// Equipment cost & utilisation over the last 12 months (office/admin — not
// payroll-sensitive). Mirrors the web Reports page.
export async function getEquipmentUtilization(): Promise<EquipUtilRow[]> {
  return fromLocalOr(
    async (db) => {
      // Same 12-month cutoff as the Supabase body below. `usage_date` is a
      // Postgres date → 'YYYY-MM-DD' text in SQLite, so lexicographic >= is safe.
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 1);
      const cutoffDate = cutoff.toISOString().slice(0, 10);

      const [equipRows, usageRows] = await Promise.all([
        db.getAll<RawEquipCostRow>(SQL_EQUIPMENT_UTILIZATION_EQUIPMENT),
        db.getAll<RawUsageRow>(SQL_EQUIPMENT_UTILIZATION_USAGE, [cutoffDate]),
      ]);
      const input: EquipUtilInput = {
        equipment: equipRows.map((r) => ({
          id: r.id,
          name: r.name,
          purchase_cost: num(r.purchase_cost),
          estimated_life_years: num(r.estimated_life_years),
          insurance_annual: num(r.insurance_annual),
          maintenance_annual: num(r.maintenance_annual),
          registration_annual: num(r.registration_annual),
          other_annual_costs: num(r.other_annual_costs),
          fuel_cost_per_hour: num(r.fuel_cost_per_hour),
          target_hours_per_year: num(r.target_hours_per_year),
        })),
        usage: usageRows.map((r) => ({ equipment_id: r.equipment_id, hours: numOrNull(r.hours) })),
      };
      return computeEquipmentUtilization(input);
    },
    async () => {
      // ← unchanged pre-PowerSync Supabase body (byte-identical fallback).
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 1);
      const cutoffDate = cutoff.toISOString().slice(0, 10);

      const [equipRes, usageRes] = await Promise.all([
        supabase.from("equipment").select("*").eq("is_active", true),
        supabase.from("equipment_usage_log").select("equipment_id, hours, usage_date").gte("usage_date", cutoffDate),
      ]);
      const input: EquipUtilInput = {
        equipment: (equipRes.data as unknown as EquipUtilInput["equipment"]) ?? [],
        usage: (usageRes.data as unknown as { equipment_id: string; hours: number | null }[]) ?? [],
      };
      return computeEquipmentUtilization(input);
    },
    { roles: ["office", "admin"] }
  );
}

// The PostgREST to-one embeds (customers(name), profiles(full_name)) become
// LEFT JOIN aliases; the mappers rebuild the flat InvoiceRow/JobStaffRow shapes
// the pure analytics helpers take, so those helpers stay untouched.
export const SQL_ANALYTICS_INVOICES = `
  SELECT i.customer_id, i.total, i.status, i.created_at, c.name AS customer_name
  FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id`;

export const SQL_ANALYTICS_JOBS = `
  SELECT j.status, p.full_name AS assignee_name
  FROM jobs j LEFT JOIN profiles p ON p.id = j.assigned_to`;

interface RawAnalyticsInvoiceRow {
  customer_id: string;
  total: number | string | null;
  status: string;
  created_at: string;
  customer_name: string | null;
}
interface RawAnalyticsJobRow {
  status: string;
  assignee_name: string | null;
}

export async function getReportAnalytics(): Promise<ReportAnalytics> {
  return fromLocalOr(
    async (db) => {
      const [invRows, jobRows] = await Promise.all([
        db.getAll<RawAnalyticsInvoiceRow>(SQL_ANALYTICS_INVOICES),
        db.getAll<RawAnalyticsJobRow>(SQL_ANALYTICS_JOBS),
      ]);

      const invoices: InvoiceRow[] = invRows.map((r) => ({
        customer_id: r.customer_id,
        customer_name: r.customer_name ?? null,
        total: numOrNull(r.total),
        status: r.status,
        created_at: r.created_at,
      }));
      const jobs: JobStaffRow[] = jobRows.map((r) => ({ assignee_name: r.assignee_name ?? null, status: r.status }));

      return {
        topCustomers: topCustomersBySpend(invoices, 8),
        revenueByMonth: revenueByMonth(invoices, lastNMonthKeys(6), (iso) => dateKeyInBusinessTZ(iso).slice(0, 7)),
        jobsByStaff: jobsByStaff(jobs),
      };
    },
    async () => {
      // ← unchanged pre-PowerSync Supabase body (byte-identical fallback).
      const [invRes, jobsRes] = await Promise.all([
        supabase.from("invoices").select("customer_id, total, status, created_at, customers(name)"),
        supabase.from("jobs").select("status, assigned_profile:profiles!jobs_assigned_to_fkey(full_name)"),
      ]);

      type InvRaw = { customer_id: string; total: number | null; status: string; created_at: string; customers: { name: string } | null };
      const invoices: InvoiceRow[] = ((invRes.data as unknown as InvRaw[]) ?? []).map((r) => ({
        customer_id: r.customer_id,
        customer_name: r.customers?.name ?? null,
        total: r.total,
        status: r.status,
        created_at: r.created_at,
      }));

      type JobRaw = { status: string; assigned_profile: { full_name: string } | null };
      const jobs: JobStaffRow[] = ((jobsRes.data as unknown as JobRaw[]) ?? []).map((r) => ({
        assignee_name: r.assigned_profile?.full_name ?? null,
        status: r.status,
      }));

      return {
        topCustomers: topCustomersBySpend(invoices, 8),
        revenueByMonth: revenueByMonth(invoices, lastNMonthKeys(6), (iso) => dateKeyInBusinessTZ(iso).slice(0, 7)),
        jobsByStaff: jobsByStaff(jobs),
      };
    },
    { roles: ["office", "admin"] }
  );
}
