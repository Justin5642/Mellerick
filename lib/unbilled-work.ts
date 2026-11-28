// Reports → Unbilled work (Justin, 28 Nov 2026): one place to see everything
// done but not yet invoiced, so labour and extras aren't left unbilled. Pure:
// the page (app/dashboard/reports/unbilled) and the Monday email
// (lib/unbilled-work-data.ts → lib/weekly-digest.ts) load the rows, these
// rules decide what is unbilled and what it is worth. Tested in
// tests/unit/unbilled-work.test.ts.
//
// Five kinds of work, each priced EXACTLY as the screen that invoices it:
//   dayworks  — signed Day Works lines (hire_entries, 0108) not on an invoice,
//               priced by lib/hire-pricing.ts priceEntry at TODAY's rates, as
//               the Day Works report and Invoice Day Works do. No hire setup
//               → "not priced", never $0.
//   load      — signed EXTRA truck loads (cartage_loads, 0111) not on an
//               invoice, priced by lib/cartage-pricing.ts priceLoad, as
//               Invoice Day Works does; one that can't be priced says why.
//   variation — approved / auto-approved variations with no invoice (the
//               Approvals "Variations to invoice" rule), the QA fixture job
//               left out. Worth total_amount, else rate × quantity (the Job
//               Ledger's variationRevenue); neither → "not priced".
//   hours     — work hours not on any invoice (lib/invoice-hours.ts
//               loadJobHours + unbilledGroups; variation time is already left
//               out there). HOURS ONLY: nothing prices hours until the office
//               uses "Apply hourly rate" on the invoice, so no rate is
//               invented here and they never add to a dollar total.
//   po        — builder POs with a value on COMPLETED jobs not (fully)
//               invoiced (lib/po-invoice.ts poInvoiceState none/part), worth
//               the PO value minus what's invoiced against it so far.
//
// Office/admin only: everything here is money from office-only tables.

import { dateKeyInBusinessTZ } from "@/lib/date";
import { billingName } from "@/lib/customer-billing";
import { optionFor, priceEntry, hireOptionLabel, type HireAttachmentRate, type HireEntryQuantities, type HireOption } from "@/lib/hire-pricing";
import { loadQuantityText, priceLoad, truckRates, DIRECTION_LABELS, type CartageLoadQuantities, type LoadCost } from "@/lib/cartage-pricing";
import { groupHours, isBilled, totalHours, type HoursEntry } from "@/lib/approved-hours";
import { poInvoiceState, pricedPos, type JobPo, type PoInvoiceRef } from "@/lib/po-invoice";

export type UnbilledKind = "dayworks" | "load" | "variation" | "hours" | "po";
export const UNBILLED_KINDS: UnbilledKind[] = ["dayworks", "load", "variation", "hours", "po"];

export const KIND_LABELS: Record<UnbilledKind, string> = {
  dayworks: "Day Works",
  load: "Extra truck loads",
  variation: "Approved variations",
  hours: "Hours to invoice",
  po: "Builder POs",
};

/**
 * Hours reach an invoice through time_entries.invoice_id since 0098 (applied
 * 15 Nov 2026). A completed job invoiced before then has every hour reading
 * "not on an invoice" although it was billed, so such jobs are not asked.
 */
export const HOURS_ON_INVOICES_SINCE = "2026-11-15";

export interface UnbilledItem {
  kind: UnbilledKind;
  /** The source row (entry / load / variation / PO id; the job id for hours). */
  id: string;
  jobId: string;
  /** Melbourne day, YYYY-MM-DD — when the work was done / approved / finished. */
  date: string;
  label: string;
  detail: string;
  /** Ex GST. null = not priced (see `problem`) or hours (never priced here). */
  amount: number | null;
  /** Why it isn't priced, in the office's words. */
  problem: string | null;
  /** Hours only (kind "hours"). */
  hours?: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;
const dollars = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** The permanent QA job (HANDOVER §7) carries a probe variation that must never be invoiced. Same rule as Approvals. */
export const isQaFixtureTitle = (title: string | null | undefined) => !!title?.startsWith("QA FIXTURE");

// ---------------------------------------------------------------- Day Works

export interface UnbilledHireEntry extends HireEntryQuantities {
  job_id: string;
  invoice_id?: string | null;
  attachment_ids: string[];
}

export function dayWorksItems(
  entries: UnbilledHireEntry[],
  options: HireOption[],
  attachments: HireAttachmentRate[],
  equipmentNames: Map<string, string>
): UnbilledItem[] {
  const out: UnbilledItem[] = [];
  for (const e of entries) {
    if (e.status !== "signed" || e.invoice_id) continue;
    const machine = equipmentNames.get(e.equipment_id) ?? "Machine";
    const priced = priceEntry(e, options, e.attachment_ids, attachments);
    const atts = priced.attachments.map((a) => a.name);
    out.push({
      kind: "dayworks",
      id: e.id,
      jobId: e.job_id,
      date: e.work_date,
      label: `${machine} — ${hireOptionLabel(e)}`,
      detail: priced.machine ? `${priced.machine.quantity} × ${dollars(priced.machine.unitPrice)}${atts.length ? ` + ${atts.join(", ")}` : ""}` : atts.join(", "),
      amount: priced.total,
      problem: optionFor(e, options) ? null : "No hire rate set up — Fleet → Hire setup.",
    });
  }
  return out;
}

// ---------------------------------------------------------------- Truck loads

export interface UnbilledLoad extends CartageLoadQuantities {
  job_id: string;
  load_date: string;
  invoice_id?: string | null;
  material?: string | null;
  place?: string | null;
}

export function loadItems(
  loads: UnbilledLoad[],
  options: (HireOption & { is_active?: boolean | null })[],
  costs: Map<string, LoadCost>,
  companyMarginPct: number | null | undefined,
  truckNames: Map<string, string>
): UnbilledItem[] {
  const out: UnbilledItem[] = [];
  for (const l of loads) {
    if (l.status !== "signed" || l.billing !== "extra" || l.invoice_id) continue;
    const price = priceLoad(l, truckRates(options, l.equipment_id), costs.get(l.id) ?? null, companyMarginPct);
    const what = l.direction === "spoil_out" ? "Spoil removal" : (l.material ?? "").trim() || "Quarry product";
    const place = (l.place ?? "").trim();
    out.push({
      kind: "load",
      id: l.id,
      jobId: l.job_id,
      date: l.load_date,
      label: `${what} ${loadQuantityText(l.quantity, l.unit)}`,
      detail: [truckNames.get(l.equipment_id) ?? "Truck", DIRECTION_LABELS[l.direction], place].filter(Boolean).join(" · "),
      amount: price.kind === "extra" && price.ok ? price.total : null,
      problem: price.kind === "extra" && !price.ok ? price.problem : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- Variations

export interface UnbilledVariationRow {
  id: string;
  job_id: string;
  status: string;
  invoice_id: string | null;
  custom_name: string | null;
  quantity: number | string | null;
  unit: string | null;
  rate: number | string | null;
  total_amount: number | string | null;
  approved_at: string | null;
  logged_at: string | null;
  variation_types: { name: string | null } | null;
}

const present = (v: unknown) => v !== null && v !== undefined && v !== "";

/** What an approved variation is worth: total_amount, else rate × quantity (the ledger's rule); null when neither is set. */
export function variationAmount(v: Pick<UnbilledVariationRow, "total_amount" | "rate" | "quantity">): number | null {
  if (present(v.total_amount)) return cents(num(v.total_amount));
  if (present(v.rate)) return cents(num(v.rate) * num(v.quantity));
  return null;
}

export function variationItems(variations: UnbilledVariationRow[], jobTitles: Map<string, string>): UnbilledItem[] {
  const out: UnbilledItem[] = [];
  for (const v of variations) {
    if ((v.status !== "approved" && v.status !== "auto_approved") || v.invoice_id) continue;
    if (isQaFixtureTitle(jobTitles.get(v.job_id))) continue;
    const when = v.approved_at ?? v.logged_at;
    const amount = variationAmount(v);
    const qty = present(v.quantity) ? `${num(v.quantity)}${v.unit ? ` ${v.unit}` : ""}` : "";
    out.push({
      kind: "variation",
      id: v.id,
      jobId: v.job_id,
      date: when ? dateKeyInBusinessTZ(when) : "",
      label: v.variation_types?.name ?? v.custom_name ?? "Variation",
      detail: [qty, v.status === "auto_approved" ? "auto-approved" : "approved"].filter(Boolean).join(" · "),
      amount,
      problem: amount === null ? "Approved without a price — set it on the Variations tab." : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- Hours

export interface HoursJob {
  id: string;
  status: string | null;
  admin_status: string | null;
  ready_to_invoice: boolean | null;
}

export interface JobInvoiceRow extends PoInvoiceRef {
  job_id: string | null;
  created_at: string | null;
}

/**
 * Which jobs' hours are asked about: ready to invoice; or completed with no
 * live invoice (unless approved before 0098, when approval with hours didn't
 * make one — Simpro-era jobs); or completed with a live invoice made since
 * hours started reaching invoices (HOURS_ON_INVOICES_SINCE). Never cancelled.
 */
export function isHoursCandidate(job: HoursJob, invoices: Pick<JobInvoiceRow, "status" | "created_at">[]): boolean {
  if (job.status === "cancelled") return false;
  if (job.ready_to_invoice) return true;
  if (job.status !== "completed") return false;
  const live = invoices.filter((i) => i.status !== "cancelled");
  if (live.length === 0) return job.admin_status !== "approved";
  return live.some((i) => !!i.created_at && dateKeyInBusinessTZ(i.created_at) >= HOURS_ON_INVOICES_SINCE);
}

/** One "hours" item per job with unbilled work hours: how many, and since when. */
export function hoursItem(jobId: string, entries: HoursEntry[]): UnbilledItem | null {
  const open = entries.filter((e) => !isBilled(e) && e.clock_out);
  const groups = groupHours(open);
  const hours = totalHours(groups);
  if (!(hours > 0)) return null;
  const first = open.map((e) => e.clock_in).sort()[0];
  return {
    kind: "hours",
    id: jobId,
    jobId,
    date: dateKeyInBusinessTZ(first),
    label: `${hours.toFixed(2)} h not on an invoice`,
    detail: groups.map((g) => `${g.staffName} ${g.hours.toFixed(2)} h${g.costCentreName ? ` (${g.costCentreName})` : ""}`).join(", "),
    amount: null,
    problem: null,
    hours,
  };
}

// ---------------------------------------------------------------- Builder POs

export interface UnbilledPo extends JobPo {
  job_id: string;
  created_at: string | null;
}

/** POs imported from Simpro were invoiced in Simpro, not here. */
export const isSimproPo = (poNumber: string | null | undefined) => /^SIMPRO-/i.test((poNumber ?? "").trim());

export function poItems(
  pos: UnbilledPo[],
  invoicesByJob: Map<string, PoInvoiceRef[]>,
  jobs: Map<string, { status: string | null; actual_end: string | null; title?: string | null }>
): UnbilledItem[] {
  const out: UnbilledItem[] = [];
  for (const po of pricedPos(pos)) {
    const job = jobs.get(po.job_id);
    if (!job || job.status !== "completed" || isSimproPo(po.po_number) || isQaFixtureTitle(job.title)) continue;
    const state = poInvoiceState(po, invoicesByJob.get(po.job_id) ?? []);
    if (state.status === "full") continue;
    const when = job.actual_end ?? po.created_at;
    out.push({
      kind: "po",
      id: po.id,
      jobId: po.job_id,
      date: when ? dateKeyInBusinessTZ(when) : "",
      label: `PO ${po.po_number}`,
      detail:
        state.status === "none"
          ? `${dollars(num(po.total_value))} — nothing invoiced yet`
          : `${dollars(state.invoiced)} of ${dollars(num(po.total_value))} invoiced (${state.invoices.map((i) => `#${i.invoice_number}`).join(", ")})`,
      amount: state.remaining,
      problem: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- Grouping

export interface UnbilledJobInfo {
  id: string;
  job_number: number | null;
  title: string | null;
  status: string | null;
  customer_id: string | null;
  customers: { name: string | null; company: string | null } | null;
}

export interface UnbilledJob {
  jobId: string;
  jobNumber: number | null;
  title: string;
  status: string | null;
  customerId: string | null;
  customer: string;
  /** Oldest item's day ("" when none carries a date). */
  oldestDate: string;
  ageDays: number | null;
  /** Priced items only, ex GST. */
  total: number;
  /** Items with a problem (not priced). Hours are not counted here. */
  unpriced: number;
  hours: number;
  items: UnbilledItem[];
}

export function daysBetween(fromKey: string, toKey: string): number {
  const [ay, am, ad] = fromKey.split("-").map(Number);
  const [by, bm, bd] = toKey.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

const KIND_ORDER = new Map(UNBILLED_KINDS.map((k, i) => [k, i]));

/** Items grouped by job, each job's items by kind then date. Jobs not in `jobs` are still listed ("Job"). */
export function groupUnbilled(items: UnbilledItem[], jobs: Map<string, UnbilledJobInfo>, todayKey: string): UnbilledJob[] {
  const byJob = new Map<string, UnbilledItem[]>();
  for (const it of items) byJob.set(it.jobId, [...(byJob.get(it.jobId) ?? []), it]);
  const out: UnbilledJob[] = [];
  for (const [jobId, list] of byJob) {
    const job = jobs.get(jobId);
    if (job && isQaFixtureTitle(job.title)) continue;
    const sorted = [...list].sort((a, b) => KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)! || a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const dates = sorted.map((i) => i.date).filter(Boolean).sort();
    const oldestDate = dates[0] ?? "";
    out.push({
      jobId,
      jobNumber: job?.job_number ?? null,
      title: job?.title ?? "Job",
      status: job?.status ?? null,
      customerId: job?.customer_id ?? null,
      customer: billingName(job?.customers) || "No customer",
      oldestDate,
      ageDays: oldestDate ? Math.max(0, daysBetween(oldestDate, todayKey)) : null,
      total: cents(sorted.reduce((s, i) => s + (i.amount ?? 0), 0)),
      unpriced: sorted.filter((i) => i.problem).length,
      hours: Math.round(sorted.reduce((s, i) => s + (i.hours ?? 0), 0) * 100) / 100,
      items: sorted,
    });
  }
  return out;
}

export type UnbilledSort = "oldest" | "value";

export interface UnbilledFilters {
  customerId: string | null;
  olderThanDays: number | null;
  sort: UnbilledSort;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUnbilledFilters(params: { customer?: string; older?: string; sort?: string }): UnbilledFilters {
  const older = typeof params.older === "string" && /^\d{1,4}$/.test(params.older.trim()) ? Number(params.older.trim()) : null;
  return {
    customerId: typeof params.customer === "string" && UUID.test(params.customer) ? params.customer : null,
    olderThanDays: older && older > 0 ? older : null,
    sort: params.sort === "value" ? "value" : "oldest",
  };
}

/** Customer and "oldest item older than N days" filters, then the sort: oldest first (default) or biggest value. */
export function filterAndSortUnbilled(jobs: UnbilledJob[], f: UnbilledFilters): UnbilledJob[] {
  const kept = jobs.filter(
    (j) => (!f.customerId || j.customerId === f.customerId) && (f.olderThanDays == null || (j.ageDays != null && j.ageDays > f.olderThanDays))
  );
  const byOldest = (a: UnbilledJob, b: UnbilledJob) =>
    (a.oldestDate || "9999").localeCompare(b.oldestDate || "9999") || b.total - a.total || (a.jobNumber ?? 0) - (b.jobNumber ?? 0);
  const byValue = (a: UnbilledJob, b: UnbilledJob) => b.total - a.total || b.hours - a.hours || byOldest(a, b);
  return [...kept].sort(f.sort === "value" ? byValue : byOldest);
}

export interface UnbilledTotals {
  total: number;
  jobs: number;
  items: number;
  unpriced: number;
  hours: number;
  oldestDays: number | null;
  byKind: Record<UnbilledKind, { items: number; total: number; unpriced: number; hours: number }>;
}

export function unbilledTotals(jobs: UnbilledJob[]): UnbilledTotals {
  const byKind = Object.fromEntries(UNBILLED_KINDS.map((k) => [k, { items: 0, total: 0, unpriced: 0, hours: 0 }])) as UnbilledTotals["byKind"];
  for (const j of jobs)
    for (const i of j.items) {
      const k = byKind[i.kind];
      k.items += 1;
      k.total = cents(k.total + (i.amount ?? 0));
      if (i.problem) k.unpriced += 1;
      k.hours = Math.round((k.hours + (i.hours ?? 0)) * 100) / 100;
    }
  const ages = jobs.map((j) => j.ageDays).filter((d): d is number => d != null);
  return {
    total: cents(jobs.reduce((s, j) => s + j.total, 0)),
    jobs: jobs.length,
    items: jobs.reduce((s, j) => s + j.items.length, 0),
    unpriced: jobs.reduce((s, j) => s + j.unpriced, 0),
    hours: Math.round(jobs.reduce((s, j) => s + j.hours, 0) * 100) / 100,
    oldestDays: ages.length ? Math.max(...ages) : null,
    byKind,
  };
}

/** Customers that appear in the list, A–Z, for the filter. */
export function unbilledCustomers(jobs: UnbilledJob[]): { id: string; name: string }[] {
  const m = new Map<string, string>();
  for (const j of jobs) if (j.customerId) m.set(j.customerId, j.customer);
  return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Where each kind is invoiced, for a job. */
export function invoiceHref(kind: UnbilledKind, jobId: string, itemId: string): string {
  if (kind === "dayworks" || kind === "load") return `/dashboard/jobs/${jobId}?tab=dayworks`;
  if (kind === "variation") return `/dashboard/jobs/${jobId}?tab=variations`;
  if (kind === "po") return `/dashboard/invoices/new?job_id=${jobId}&po_id=${itemId}`;
  return `/dashboard/invoices/new?job_id=${jobId}`;
}

const CSV_COLUMNS = ["Job", "Title", "Customer", "Job status", "Kind", "Date", "Days old", "Item", "Detail", "Amount ex GST", "Hours", "Not priced because"] as const;

function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One CSV row per item, in the jobs' order. */
export function unbilledCsv(jobs: UnbilledJob[], todayKey: string): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const j of jobs)
    for (const i of j.items)
      lines.push(
        [
          j.jobNumber ?? "",
          j.title,
          j.customer,
          j.status ?? "",
          KIND_LABELS[i.kind],
          i.date,
          i.date ? Math.max(0, daysBetween(i.date, todayKey)) : "",
          i.label,
          i.detail,
          i.amount == null ? "" : i.amount.toFixed(2),
          i.hours == null ? "" : i.hours.toFixed(2),
          i.problem ?? "",
        ]
          .map(csvCell)
          .join(",")
      );
  return lines.join("\r\n") + "\r\n";
}

/** The Monday email's one line: "$X across N jobs (oldest D days)". null when nothing is unbilled. */
export interface UnbilledDigest {
  total: number;
  jobs: number;
  oldestDays: number | null;
  hours: number;
  unpriced: number;
}

export function unbilledDigest(jobs: UnbilledJob[]): UnbilledDigest {
  const t = unbilledTotals(jobs);
  return { total: t.total, jobs: t.jobs, oldestDays: t.oldestDays, hours: t.hours, unpriced: t.unpriced };
}
