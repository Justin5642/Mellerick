// Reads behind Reports → Unbilled work and the Monday email's "Unbilled work"
// line. The rules are in lib/unbilled-work.ts; this only fetches rows.
//
// `db` runs every read: the page passes the CALLER's session (office/admin —
// RLS decides, as everywhere else), the weekly digest the service role (a cron
// has no user). One figure is different: the company cartage margin lives in
// billing_rate_config, which RLS keeps admin-only, so it comes from
// `marginDb` — the page passes the service role AFTER checking the viewer is
// office/admin, exactly as Invoice Day Works and the Truck loads routes do.
//
// Named columns only (time_entries has column-level grants and its
// rate_override is never read); multi-row reads paged past PostgREST's
// 1000-row cap with fetchAllRows; `.in()` lookups chunked to 100 ids. A
// section whose table or column is missing (before its migration) or whose
// read fails is left out with a note — it never breaks the rest.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { loadJobHours } from "@/lib/invoice-hours";
import type { HoursEntry } from "@/lib/approved-hours";
import type { HireAttachmentRate, HireOption } from "@/lib/hire-pricing";
import type { LoadCost } from "@/lib/cartage-pricing";
import {
  dayWorksItems,
  hoursItem,
  isHoursCandidate,
  loadItems,
  poItems,
  variationItems,
  KIND_LABELS,
  type JobInvoiceRow,
  type UnbilledHireEntry,
  type UnbilledItem,
  type UnbilledJobInfo,
  type UnbilledKind,
  type UnbilledLoad,
  type UnbilledPo,
  type UnbilledVariationRow,
} from "@/lib/unbilled-work";

const CHUNK = 100;
const MISSING = new Set(["42P01", "PGRST205", "PGRST200", "42703", "PGRST204"]);

type Failure = { message: string; code?: string };
class ReadError extends Error {
  code?: string;
  constructor(what: string, f: Failure) {
    super(`${what}: ${f.message}`);
    this.code = f.code;
  }
}

const isMissing = (e: unknown) => e instanceof ReadError && MISSING.has(e.code ?? "");

async function all<T>(what: string, build: Parameters<typeof fetchAllRows<T>>[0]): Promise<T[]> {
  const res = await fetchAllRows<T>(build);
  if (!res.ok) throw new ReadError(what, { message: res.error, code: res.code });
  return res.rows;
}

/** `select columns from table where column in ids`, 100 ids a request, every request paged. */
async function byIn<T>(db: SupabaseClient, what: string, table: string, columns: string, column: string, ids: Iterable<string>): Promise<T[]> {
  const uniq = [...new Set(ids)];
  const chunks: string[][] = [];
  for (let i = 0; i < uniq.length; i += CHUNK) chunks.push(uniq.slice(i, i + CHUNK));
  const parts = await Promise.all(
    chunks.map((c) => all<T>(what, (count) => db.from(table).select(columns, count).in(column, c).order("id") as never))
  );
  return parts.flat();
}

export interface UnbilledLoadResult {
  items: UnbilledItem[];
  jobs: Map<string, UnbilledJobInfo>;
  /** One line per section left out: "Truck loads aren't switched on yet." */
  notes: { kind: UnbilledKind; text: string }[];
}

const JOB_COLUMNS = "id, job_number, title, status, admin_status, ready_to_invoice, actual_end, customer_id, customers(name, company)";
type JobRow = UnbilledJobInfo & { admin_status: string | null; ready_to_invoice: boolean | null; actual_end: string | null };

/** Closed work hours of these jobs, ten jobs a read (loadJobHours reads unpaged — a read that hits the cap is redone job by job). */
async function hoursFor(db: SupabaseClient, jobIds: string[]): Promise<Map<string, HoursEntry[]>> {
  const out = new Map<string, HoursEntry[]>();
  for (let i = 0; i < jobIds.length; i += 10) {
    const chunk = jobIds.slice(i, i + 10);
    let got = await loadJobHours(db, chunk);
    const rows = [...got.values()].reduce((s, l) => s + l.length, 0);
    if (rows >= 1000 && chunk.length > 1) {
      got = new Map();
      for (const id of chunk) for (const [k, v] of await loadJobHours(db, [id])) got.set(k, v);
    }
    for (const [k, v] of got) out.set(k, v);
  }
  return out;
}

export async function loadUnbilledWork(db: SupabaseClient, marginDb: SupabaseClient): Promise<UnbilledLoadResult> {
  const items: UnbilledItem[] = [];
  const notes: UnbilledLoadResult["notes"] = [];
  const jobs = new Map<string, JobRow>();

  const section = async (kind: UnbilledKind, run: () => Promise<void>) => {
    try {
      await run();
    } catch (err) {
      if (isMissing(err)) {
        notes.push({ kind, text: `${KIND_LABELS[kind]} aren't switched on in this database yet, so they're left out.` });
      } else {
        console.error(`unbilled work: ${kind} read failed:`, err);
        notes.push({ kind, text: `${KIND_LABELS[kind]} couldn't be read, so they're left out. Refresh to try again.` });
      }
    }
  };

  // Rate tables, shared by Day Works and truck loads.
  let options: (HireOption & { is_active: boolean | null })[] | null = null;
  const loadOptions = async () => {
    options ??= await all<HireOption & { is_active: boolean | null }>("Hire options", (count) =>
      db
        .from("equipment_hire_options")
        .select("id, equipment_id, hire_type, hire_unit, rate, whole_days_only, float_base, float_km_included, float_per_km, cost_centre_id, is_active", count)
        .order("id") as never
    );
    return options;
  };
  const equipmentNames = async (ids: string[]) =>
    new Map((await byIn<{ id: string; name: string }>(db, "Equipment", "equipment", "id, name", "id", ids)).map((e) => [e.id, e.name]));

  await section("dayworks", async () => {
    type Raw = Omit<UnbilledHireEntry, "attachment_ids"> & { hire_entry_attachments: { attachment_id: string }[] | null };
    const raw = await all<Raw>("Day Works", (count) =>
      db
        .from("hire_entries")
        .select("id, job_id, equipment_id, hire_type, hire_unit, work_date, hours, days, meter_open, meter_close, km, status, invoice_id, cost_centre_id, hire_entry_attachments(attachment_id)", count)
        .eq("status", "signed")
        .is("invoice_id", null)
        .order("id") as never
    );
    if (raw.length === 0) return;
    const entries: UnbilledHireEntry[] = raw.map(({ hire_entry_attachments, ...e }) => ({ ...e, attachment_ids: (hire_entry_attachments ?? []).map((a) => a.attachment_id) }));
    const [opts, attachments, names] = await Promise.all([
      loadOptions(),
      all<HireAttachmentRate>("Hire attachments", (count) => db.from("hire_attachments").select("id, name, day_rate", count).order("id") as never),
      equipmentNames(entries.map((e) => e.equipment_id)),
    ]);
    items.push(...dayWorksItems(entries, opts, attachments, names));
  });

  await section("load", async () => {
    const loads = await all<UnbilledLoad>("Truck loads", (count) =>
      db
        .from("cartage_loads")
        .select("id, job_id, equipment_id, load_date, direction, billing, quantity, unit, km, material, place, status, invoice_id", count)
        .eq("status", "signed")
        .eq("billing", "extra")
        .is("invoice_id", null)
        .order("id") as never
    );
    if (loads.length === 0) return;
    const [opts, costs, names, config] = await Promise.all([
      loadOptions(),
      byIn<LoadCost & { load_id: string }>(db, "Load costs", "cartage_load_costs", "load_id, docket_cost_ex_gst, margin_pct", "load_id", loads.map((l) => l.id)),
      equipmentNames(loads.map((l) => l.equipment_id)),
      marginDb.from("billing_rate_config").select("cartage_margin_pct").maybeSingle(),
    ]);
    if (config.error) throw new ReadError("Cartage margin", config.error);
    const margin = (config.data as { cartage_margin_pct: number | null } | null)?.cartage_margin_pct ?? null;
    items.push(...loadItems(loads, opts, new Map(costs.map((c) => [c.load_id, c])), margin, names));
  });

  // Variations need their job's title (the QA fixture rule), read below with the rest.
  let variations: UnbilledVariationRow[] = [];
  await section("variation", async () => {
    variations = await all<UnbilledVariationRow>("Variations", (count) =>
      db
        .from("job_variations")
        .select("id, job_id, status, invoice_id, custom_name, quantity, unit, rate, total_amount, approved_at, logged_at, variation_types(name)", count)
        .in("status", ["approved", "auto_approved"])
        .is("invoice_id", null)
        .order("id") as never
    );
  });

  // Hours and POs start from the jobs that are finished or waiting to be invoiced.
  let finished: JobRow[] = [];
  let invoicesByJob = new Map<string, JobInvoiceRow[]>();
  let finishedOk = true;
  try {
    finished = await all<JobRow>("Jobs", (count) =>
      db.from("jobs").select(JOB_COLUMNS, count).or("status.eq.completed,ready_to_invoice.eq.true").neq("status", "cancelled").order("id") as never
    );
    for (const j of finished) jobs.set(j.id, j);
    const invoices = await byIn<JobInvoiceRow>(
      db,
      "Invoices",
      "invoices",
      "id, job_id, invoice_number, subtotal, status, customer_po, created_at",
      "job_id",
      finished.map((j) => j.id)
    );
    invoicesByJob = new Map();
    for (const inv of invoices) if (inv.job_id) invoicesByJob.set(inv.job_id, [...(invoicesByJob.get(inv.job_id) ?? []), inv]);
  } catch (err) {
    console.error("unbilled work: finished jobs read failed:", err);
    finishedOk = false;
    notes.push({ kind: "hours", text: "Finished jobs couldn't be read, so hours and builder POs are left out. Refresh to try again." });
  }

  if (finishedOk) {
    await section("hours", async () => {
      const candidates = finished.filter((j) => isHoursCandidate(j, invoicesByJob.get(j.id) ?? [])).map((j) => j.id);
      const hours = await hoursFor(db, candidates);
      for (const id of candidates) {
        const it = hoursItem(id, hours.get(id) ?? []);
        if (it) items.push(it);
      }
    });
    await section("po", async () => {
      const completed = finished.filter((j) => j.status === "completed").map((j) => j.id);
      const pos = await byIn<UnbilledPo>(db, "Purchase orders", "purchase_orders", "id, job_id, po_number, total_value, created_at", "job_id", completed);
      items.push(...poItems(pos, invoicesByJob, jobs));
    });
  }

  // Every other job an item names (Day Works, loads, variations on open jobs).
  const missingJobs = [...new Set([...items.map((i) => i.jobId), ...variations.map((v) => v.job_id)])].filter((id) => !jobs.has(id));
  if (missingJobs.length > 0) {
    try {
      for (const j of await byIn<JobRow>(db, "Jobs", "jobs", JOB_COLUMNS, "id", missingJobs)) jobs.set(j.id, j);
    } catch (err) {
      console.error("unbilled work: job details read failed:", err);
      notes.push({ kind: "variation", text: "Some jobs' details couldn't be read — they're listed by id only." });
    }
  }
  items.push(...variationItems(variations, new Map([...jobs.values()].map((j) => [j.id, j.title ?? ""]))));

  return { items, jobs, notes };
}
