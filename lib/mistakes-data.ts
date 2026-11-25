// Reading mistakes (0115 + 0119 (a draft, not applied yet)) for the office's screens, the reports and the
// ledgers. Works on any Supabase client (browser, server, admin) — every read
// runs under whoever the client is, so RLS decides: office/admin see mistakes
// and cost lines; only admin sees loaded labour rates (staff_cost_profiles)
// and whose mistake it was (mistake_responsibility).
//
// Three states, so the web can be deployed before or after 0119:
//   "missing"  — no job_mistakes table (before 0115): nothing to show.
//   "legacy"   — 0115 only: each mistake's amount_ex_gst becomes one manual
//                line, so every screen and ledger reads the same shape.
//   "tracking" — 0119 applied: the real cost lines.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { attachEffectiveRates } from "@/lib/fleet-rates";
import { usageCost } from "@/lib/fleet-costs";
import { loadedRatesByStaff } from "@/lib/job-ledger";
import { priceEntry, type HireEntryQuantities, type HireOption } from "@/lib/hire-pricing";
import { emptySources, ledgerMistake, linesByMistake, mistakeMoney, type CostSources, type MistakeCostLine, type MistakeMoney } from "@/lib/mistake-costs";

export type TrackingMode = "missing" | "legacy" | "tracking";

export const TRACKED_COLUMNS =
  "id, job_id, cost_center_id, cost_centre_id, category_id, cause_code, cause, description, occurred_on, status, closed_at, " +
  "raised_by, raised_at, supplier_id, recovery_source, recovery_claimed_ex_gst, recovered_ex_gst, recovery_claimed_on, " +
  "recovery_note, amount_ex_gst, created_at";
const LEGACY_COLUMNS = "id, job_id, cost_center_id, occurred_on, amount_ex_gst, description, cause, entered_by, created_at";
export const LINE_COLUMNS = "id, mistake_id, kind, source, source_id, hours, amount_ex_gst, note, legacy, created_at";

export interface TrackedMistake {
  id: string;
  job_id: string | null;
  cost_center_id: string | null;
  cost_centre_id: string | null;
  category_id: string | null;
  cause_code: string | null;
  cause: string | null;
  description: string;
  occurred_on: string;
  status: string;
  closed_at: string | null;
  raised_by: string | null;
  raised_at: string | null;
  supplier_id: string | null;
  recovery_source: string | null;
  recovery_claimed_ex_gst: number | null;
  recovered_ex_gst: number | null;
  recovery_claimed_on: string | null;
  recovery_note: string | null;
  amount_ex_gst: number | null;
  created_at: string;
}

/** A missing table (before 0115). */
export function isMissingTable(error: { code?: string | null } | null | undefined): boolean {
  return !!error && ["42P01", "PGRST205"].includes(error.code ?? "");
}
/** A missing column or embed (0115 without 0119). */
export function isMissingColumn(error: { code?: string | null } | null | undefined): boolean {
  return !!error && ["42703", "PGRST204", "PGRST200"].includes(error.code ?? "");
}

const CHUNK = 100;
const chunks = <T,>(a: T[], n = CHUNK) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const num = (v: unknown) => (v == null ? null : Number(v));

function normalise(m: Record<string, unknown>): TrackedMistake {
  return {
    id: String(m.id),
    job_id: (m.job_id as string | null) ?? null,
    cost_center_id: (m.cost_center_id as string | null) ?? null,
    cost_centre_id: (m.cost_centre_id as string | null) ?? null,
    category_id: (m.category_id as string | null) ?? null,
    cause_code: (m.cause_code as string | null) ?? null,
    cause: (m.cause as string | null) ?? null,
    description: String(m.description ?? ""),
    occurred_on: String(m.occurred_on),
    status: (m.status as string | undefined) ?? (m.amount_ex_gst != null ? "costed" : "open"),
    closed_at: (m.closed_at as string | null) ?? null,
    raised_by: (m.raised_by as string | null) ?? (m.entered_by as string | null) ?? null,
    raised_at: (m.raised_at as string | null) ?? (m.created_at as string | null) ?? null,
    supplier_id: (m.supplier_id as string | null) ?? null,
    recovery_source: (m.recovery_source as string | null) ?? null,
    recovery_claimed_ex_gst: num(m.recovery_claimed_ex_gst),
    recovered_ex_gst: num(m.recovered_ex_gst),
    recovery_claimed_on: (m.recovery_claimed_on as string | null) ?? null,
    recovery_note: (m.recovery_note as string | null) ?? null,
    amount_ex_gst: num(m.amount_ex_gst),
    created_at: String(m.created_at ?? ""),
  };
}

export interface MistakeFilter {
  jobId?: string;
  jobIds?: string[];
  /** occurred_on on or after (YYYY-MM-DD). */
  from?: string;
  /** Only mistakes not closed. */
  openOnly?: boolean;
  /** Only mistakes with no job. */
  noJob?: boolean;
}

export interface LoadedMistakes {
  mode: TrackingMode;
  mistakes: TrackedMistake[];
  lines: MistakeCostLine[];
  error: string | null;
}

/** Mistakes and their cost lines. A read error is returned (never thrown) for the caller to report with a fixed sentence. */
export async function loadMistakes(db: SupabaseClient, filter: MistakeFilter = {}): Promise<LoadedMistakes> {
  const read = async (columns: string, jobIds: string[] | null) => {
    const rows: Record<string, unknown>[] = [];
    const parts = jobIds ? chunks(jobIds) : [null];
    for (const part of parts) {
      const res = await fetchAllRows<Record<string, unknown>>((count) => {
        let q = db.from("job_mistakes").select(columns, count);
        if (part) q = q.in("job_id", part);
        if (filter.jobId) q = q.eq("job_id", filter.jobId);
        if (filter.noJob) q = q.is("job_id", null);
        if (filter.from) q = q.gte("occurred_on", filter.from);
        if (filter.openOnly && columns === TRACKED_COLUMNS) q = q.neq("status", "closed");
        return q.order("id") as never;
      });
      if (!res.ok) return res;
      rows.push(...res.rows);
    }
    return { ok: true as const, rows };
  };
  const jobIds = filter.jobIds ? [...new Set(filter.jobIds)] : null;
  if (jobIds && jobIds.length === 0) return { mode: "tracking", mistakes: [], lines: [], error: null };

  const tracked = await read(TRACKED_COLUMNS, jobIds);
  if (tracked.ok) {
    const mistakes = tracked.rows.map(normalise);
    const lines = await loadCostLines(db, mistakes.map((m) => m.id));
    if (!lines.ok) {
      if (isMissingTable({ code: lines.code }) || isMissingColumn({ code: lines.code })) {
        return { mode: "legacy", mistakes, lines: legacyLines(mistakes), error: null };
      }
      return { mode: "tracking", mistakes, lines: [], error: lines.error };
    }
    return { mode: "tracking", mistakes, lines: lines.rows, error: null };
  }
  if (isMissingTable({ code: tracked.code })) return { mode: "missing", mistakes: [], lines: [], error: null };
  if (!isMissingColumn({ code: tracked.code })) return { mode: "tracking", mistakes: [], lines: [], error: tracked.error };

  if (filter.noJob) return { mode: "legacy", mistakes: [], lines: [], error: null };
  const legacy = await read(LEGACY_COLUMNS, jobIds);
  if (!legacy.ok) {
    if (isMissingTable({ code: legacy.code })) return { mode: "missing", mistakes: [], lines: [], error: null };
    return { mode: "legacy", mistakes: [], lines: [], error: legacy.error };
  }
  const mistakes = legacy.rows.map(normalise);
  return { mode: "legacy", mistakes, lines: legacyLines(mistakes), error: null };
}

/** 0115-only: each amount is one manual line. */
export function legacyLines(mistakes: TrackedMistake[]): MistakeCostLine[] {
  return mistakes
    .filter((m) => m.amount_ex_gst != null && m.amount_ex_gst > 0)
    .map((m) => ({
      id: `legacy-${m.id}`,
      mistake_id: m.id,
      kind: "other",
      source: "manual",
      source_id: null,
      hours: null,
      amount_ex_gst: m.amount_ex_gst,
      note: null,
      legacy: true,
      created_at: m.created_at,
    }));
}

async function loadCostLines(db: SupabaseClient, mistakeIds: string[]): Promise<{ ok: true; rows: MistakeCostLine[] } | { ok: false; error: string; code?: string }> {
  const rows: MistakeCostLine[] = [];
  for (const part of chunks(mistakeIds)) {
    const res = await fetchAllRows<MistakeCostLine>((count) =>
      db.from("mistake_cost_lines").select(LINE_COLUMNS, count).in("mistake_id", part).order("id") as never
    );
    if (!res.ok) return res;
    rows.push(
      ...res.rows.map((l) => ({ ...l, hours: l.hours == null ? null : Number(l.hours), amount_ex_gst: l.amount_ex_gst == null ? null : Number(l.amount_ex_gst) }))
    );
  }
  return { ok: true, rows };
}

/** What each linked record is, for the office's screens (no money beyond what the office already sees). */
export interface SourceInfo {
  date: string | null;
  title: string;
  jobId: string | null;
}

const EQUIPMENT_COST_COLUMNS =
  "id, name, assigned_to, purchase_date, created_at, purchase_cost, estimated_life_years, insurance_annual, maintenance_annual, " +
  "registration_annual, other_annual_costs, fuel_cost_per_hour, target_hours_per_year, cost_per_load, day_rate";
const STAFF_COST_COLUMNS = "staff_id, hourly_rate, super_rate, workers_comp_rate, leave_loading_rate, annual_fixed_oncosts, target_hours_per_week";

async function byIds<T>(db: SupabaseClient, table: string, columns: string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunks([...new Set(ids)])) {
    const { data, error } = await db.from(table).select(columns).in("id", part);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

/**
 * The records the linked lines point at, costed as the Job Ledger costs them.
 * `withRates`: read loaded labour rates (admin only by RLS — pass false for
 * office, whose labour lines then show hours with the cost hidden).
 */
export async function loadCostSources(
  db: SupabaseClient,
  lines: Pick<MistakeCostLine, "source" | "source_id">[],
  opts: { withRates: boolean; staffNames?: Map<string, string> }
): Promise<{ sources: CostSources; info: Map<string, SourceInfo> }> {
  const sources = emptySources();
  const info = new Map<string, SourceInfo>();
  const ids = (source: string) => lines.filter((l) => l.source === source && l.source_id).map((l) => l.source_id as string);
  const key = (source: string, id: string) => `${source}:${id}`;
  const name = (id: string | null | undefined) => (id ? opts.staffNames?.get(id) ?? "Staff member" : "Staff member");

  const [times, expenses, orders, usage, hire] = await Promise.all([
    byIds<{ id: string; job_id: string; staff_id: string; hours: number | null; entry_type: string | null; clock_in: string }>(
      db, "time_entries", "id, job_id, staff_id, hours, entry_type, clock_in", ids("time_entry")
    ),
    byIds<{ id: string; job_id: string; amount: number | null; supplier_name: string | null; description: string | null; invoice_date: string | null; created_at: string | null }>(
      db, "job_expenses", "id, job_id, amount, supplier_name, description, invoice_date, created_at", ids("job_expense")
    ),
    byIds<{ id: string; job_id: string; amount: number | null; status: string; po_number: string | null; vendor_name: string | null; order_date: string | null }>(
      db, "vendor_orders", "id, job_id, amount, status, po_number, vendor_name, order_date", ids("vendor_order")
    ),
    byIds<{ id: string; job_id: string | null; equipment_id: string; hours: number; loads: number | null; days: number | null; usage_date: string }>(
      db, "equipment_usage_log", "id, job_id, equipment_id, hours, loads, days, usage_date", ids("equipment_usage")
    ),
    byIds<HireEntryQuantities & { job_id: string }>(
      db, "hire_entries", "id, job_id, equipment_id, hire_type, hire_unit, work_date, hours, days, meter_open, meter_close, km, status, cost_centre_id", ids("hire_entry")
    ),
  ]);

  // Equipment: what the usage lines name, plus vehicles assigned to people
  // (folded into their labour rate, as in the ledger).
  const equipmentIds = [...new Set([...usage.map((u) => u.equipment_id), ...hire.map((h) => h.equipment_id)])];
  let equipment: Array<Record<string, unknown> & { id: string; name?: string; assigned_to?: string | null }> = [];
  if (equipmentIds.length || (opts.withRates && times.length)) {
    const named = equipmentIds.length ? await byIds<Record<string, unknown> & { id: string }>(db, "equipment", EQUIPMENT_COST_COLUMNS, equipmentIds) : [];
    let assigned: Array<Record<string, unknown> & { id: string }> = [];
    if (opts.withRates && times.length) {
      const { data, error } = await db.from("equipment").select(EQUIPMENT_COST_COLUMNS).not("assigned_to", "is", null);
      if (error) throw new Error(`equipment: ${error.message}`);
      assigned = (data ?? []) as never[];
    }
    const all = new Map([...named, ...assigned].map((e) => [e.id, e]));
    equipment = (await attachEffectiveRates(db, [...all.values()] as never[])) as never[];
  }
  const equipmentById = new Map(equipment.map((e) => [e.id, e]));

  if (opts.withRates) {
    const { data, error } = await db.from("staff_cost_profiles").select(STAFF_COST_COLUMNS);
    if (error) throw new Error(`staff_cost_profiles: ${error.message}`);
    sources.ratesByStaff = loadedRatesByStaff((data ?? []) as never[], equipment as never[]);
  }

  for (const t of times) {
    sources.timeEntries.set(t.id, { staff_id: t.staff_id, hours: t.hours == null ? null : Number(t.hours), entry_type: t.entry_type });
    info.set(key("time_entry", t.id), {
      date: t.clock_in,
      title: `${name(t.staff_id)} · ${t.hours == null ? "still clocked on" : `${Number(t.hours)} h`}${t.entry_type === "travel" ? " travel" : ""}`,
      jobId: t.job_id,
    });
  }
  for (const e of expenses) {
    sources.expenses.set(e.id, { amount: e.amount == null ? null : Number(e.amount) });
    info.set(key("job_expense", e.id), { date: e.invoice_date ?? e.created_at, title: [e.supplier_name, e.description].filter(Boolean).join(" — ") || "Expense", jobId: e.job_id });
  }
  for (const o of orders) {
    sources.vendorOrders.set(o.id, { amount: o.amount == null ? null : Number(o.amount), status: o.status });
    info.set(key("vendor_order", o.id), { date: o.order_date, title: [o.po_number, o.vendor_name].filter(Boolean).join(" · ") || "Supplier PO", jobId: o.job_id });
  }
  for (const u of usage) {
    const eq = equipmentById.get(u.equipment_id);
    sources.usage.set(u.id, eq ? usageCost(u, eq as never) : 0);
    const parts = [Number(u.hours) ? `${Number(u.hours)} h` : null, Number(u.loads) ? `${u.loads} loads` : null, Number(u.days) ? `${u.days} days` : null].filter(Boolean);
    info.set(key("equipment_usage", u.id), { date: u.usage_date, title: [eq?.name ?? "Equipment", parts.join(", ")].filter(Boolean).join(" · "), jobId: u.job_id });
  }
  if (hire.length) {
    const { data, error } = await db
      .from("equipment_hire_options")
      .select("equipment_id, hire_type, hire_unit, rate, whole_days_only, float_base, float_km_included, float_per_km, cost_centre_id, is_active")
      .in("equipment_id", [...new Set(hire.map((h) => h.equipment_id))]);
    const options = error ? [] : ((data ?? []) as Array<HireOption & { is_active?: boolean }>).filter((o) => o.is_active !== false);
    for (const h of hire) {
      sources.hire.set(h.id, priceEntry(h, options, [], []).total);
      info.set(key("hire_entry", h.id), {
        date: h.work_date,
        title: `${(equipmentById.get(h.equipment_id)?.name as string | undefined) ?? "Machine"} · Day Works (${h.status ?? "draft"})`,
        jobId: h.job_id,
      });
    }
  }
  return { sources, info };
}

export interface MistakeWithMoney extends TrackedMistake {
  money: MistakeMoney;
}

export function withMoney(mistakes: TrackedMistake[], lines: MistakeCostLine[], sources: CostSources): MistakeWithMoney[] {
  const by = linesByMistake(lines);
  return mistakes.map((m) => ({ ...m, money: mistakeMoney(by.get(m.id) ?? [], m, sources) }));
}

/** The Job Ledger's `mistakes` input for a set of mistakes. */
export function ledgerMistakes(mistakes: TrackedMistake[], lines: MistakeCostLine[], sources: CostSources) {
  const by = linesByMistake(lines);
  return mistakes.map((m) => ({ job_id: m.job_id, ...ledgerMistake(m, by.get(m.id) ?? [], sources) }));
}
