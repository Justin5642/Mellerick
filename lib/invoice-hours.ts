// Loading a job's hours for its invoice, and billing them (migration 0098 — draft, not applied yet).
//
// Two clients, deliberately:
//   db    — the CALLER's session. Reads the job's hours and invoice under RLS,
//           and calls apply_invoice_hours(), which checks office/admin itself
//           from auth.uid(). Never the service role, or that check sees nobody.
//   admin — service role, for the two rate sources RLS keeps from office staff:
//           staff_cost_profiles (admin-only, 0014) and billing_rate_config.
//           Callers authorise the user BEFORE passing it in.
//
// Every read throws on error. A failed read here does not mean "no hours" — it
// means we do not know, and billing from a guess goes to the customer.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildHourLines,
  defaultRates,
  groupHours,
  quoteHourlyRate,
  totalHours,
  type HoursEntry,
  type HoursGroup,
  type RateChoice,
  type RateDefaults,
} from "@/lib/approved-hours";
import { DEFAULT_LABOUR_RATE_CONFIG } from "@/lib/labour-billing";

// Column list, not `*`: time_entries has column-level grants (0045) and `*`
// is refused outright. invoice_id needs 0098.
const HOURS_SELECT =
  "id, job_id, staff_id, entry_type, clock_in, clock_out, cost_center_id, invoice_id, profiles!time_entries_staff_id_fkey(full_name), po_cost_centers(name)";

function must<T>(res: { data: T; error: { message?: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what} could not be read — ${res.error.message ?? "unknown error"}`);
  return res.data;
}

/** Closed work entries for each job, keyed by job id. */
export async function loadJobHours(db: SupabaseClient, jobIds: string[]): Promise<Map<string, HoursEntry[]>> {
  const byJob = new Map<string, HoursEntry[]>();
  if (jobIds.length === 0) return byJob;
  const rows = must(
    await db
      .from("time_entries")
      .select(HOURS_SELECT)
      .in("job_id", jobIds)
      .eq("entry_type", "work")
      .not("clock_out", "is", null)
      .order("clock_in"),
    "Time entries"
  ) as any[];
  for (const r of rows ?? []) {
    const entry: HoursEntry = {
      id: r.id,
      staff_id: r.staff_id,
      staff_name: r.profiles?.full_name ?? null,
      cost_center_id: r.cost_center_id ?? null,
      cost_center_name: r.po_cost_centers?.name ?? null,
      entry_type: r.entry_type,
      clock_in: r.clock_in,
      clock_out: r.clock_out,
      invoice_id: r.invoice_id ?? null,
    };
    const list = byJob.get(r.job_id) ?? [];
    list.push(entry);
    byJob.set(r.job_id, list);
  }
  return byJob;
}

/** Hours not on any invoice yet, grouped — what an approval carries to the invoice. */
export function unbilledGroups(entries: HoursEntry[]): HoursGroup[] {
  return groupHours(entries.filter((e) => e.invoice_id == null));
}

export async function loadRateDefaults(admin: SupabaseClient, jobId: string, groups: HoursGroup[]): Promise<RateDefaults> {
  const staffIds = [...new Set(groups.map((g) => g.staffId))];
  const [quotesRes, profilesRes, configRes] = await Promise.all([
    admin
      .from("quotes")
      .select("status, created_at, quote_items(unit_price, created_at, pricing_items(pricing_type))")
      .eq("job_id", jobId)
      .neq("status", "declined")
      .order("created_at"),
    staffIds.length
      ? admin.from("staff_cost_profiles").select("staff_id, charge_out_rate").in("staff_id", staffIds)
      : Promise.resolve({ data: [], error: null }),
    admin.from("billing_rate_config").select("qualified_base_rate").eq("id", true).maybeSingle(),
  ]);
  const quotes = (must(quotesRes, "Quotes") ?? []) as any[];
  const profiles = (must(profilesRes as any, "Staff charge-out rates") ?? []) as any[];
  const config = must(configRes, "Billing rates") as any;

  // An accepted quote wins over a sent or draft one.
  const ordered = [...quotes.filter((q) => q.status === "accepted"), ...quotes.filter((q) => q.status !== "accepted")];
  const lines = ordered.flatMap((q) =>
    [...(q.quote_items ?? [])]
      .sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((i: any) => ({ unit_price: i.unit_price, pricing_type: i.pricing_items?.pricing_type ?? null }))
  );

  const companyRate = Number(config?.qualified_base_rate);
  return defaultRates({
    groups,
    quoteRate: quoteHourlyRate(lines),
    chargeOutByStaff: Object.fromEntries(profiles.map((p) => [p.staff_id, p.charge_out_rate == null ? null : Number(p.charge_out_rate)])),
    companyRate: Number.isFinite(companyRate) && companyRate > 0 ? companyRate : DEFAULT_LABOUR_RATE_CONFIG.qualifiedBaseRate,
  });
}

export interface InvoiceHoursView {
  invoiceId: string;
  jobId: string | null;
  /** Hours not billed anywhere yet, plus hours already billed on THIS invoice. */
  groups: Array<HoursGroup & { billedHere: boolean }>;
  unbilledHours: number;
  billedHereHours: number;
  /** Hours on this job already billed on a different invoice. Shown, not re-billed. */
  billedElsewhereHours: number;
  defaults: RateDefaults | null;
  locked: boolean;
}

/** `admin` null skips the rate defaults (the apply path recomputes groups only). */
export async function loadInvoiceHours(db: SupabaseClient, admin: SupabaseClient | null, invoiceId: string): Promise<InvoiceHoursView | null> {
  const invoice = must(
    await db.from("invoices").select("id, job_id, status").eq("id", invoiceId).maybeSingle(),
    "The invoice"
  ) as { id: string; job_id: string | null; status: string } | null;
  if (!invoice) return null;
  const empty: InvoiceHoursView = {
    invoiceId,
    jobId: invoice.job_id,
    groups: [],
    unbilledHours: 0,
    billedHereHours: 0,
    billedElsewhereHours: 0,
    defaults: null,
    locked: invoice.status === "paid" || invoice.status === "cancelled",
  };
  if (!invoice.job_id) return empty;

  const entries = (await loadJobHours(db, [invoice.job_id])).get(invoice.job_id) ?? [];
  const mine = entries.filter((e) => e.invoice_id == null || e.invoice_id === invoiceId);
  const elsewhere = entries.filter((e) => e.invoice_id != null && e.invoice_id !== invoiceId);
  const groups = groupHours(mine).map((g) => ({
    ...g,
    billedHere: g.entryIds.every((id) => mine.find((e) => e.id === id)?.invoice_id === invoiceId),
  }));

  return {
    ...empty,
    groups,
    unbilledHours: totalHours(groupHours(mine.filter((e) => e.invoice_id == null))),
    billedHereHours: totalHours(groupHours(mine.filter((e) => e.invoice_id === invoiceId))),
    billedElsewhereHours: totalHours(groupHours(elsewhere)),
    defaults: admin && groups.length ? await loadRateDefaults(admin, invoice.job_id, groups) : null,
  };
}

export type ApplyHoursResult =
  | { ok: true; lines: number; entries: number; hours: number; subtotal: number; tax: number; total: number }
  | { ok: false; status: number; error: string };

/**
 * Price the job's hours and write them onto the invoice, in one transaction.
 * The groups are rebuilt here from the database — the browser sends only the
 * rates, never which entries to bill.
 */
export async function applyInvoiceHours(
  db: SupabaseClient,
  invoiceId: string,
  choice: RateChoice
): Promise<ApplyHoursResult> {
  const view = await loadInvoiceHours(db, null, invoiceId).catch((e: Error) => ({ error: e.message }) as const);
  if (!view) return { ok: false, status: 404, error: "Invoice not found." };
  if ("error" in view) return { ok: false, status: 500, error: view.error };
  if (!view.jobId) return { ok: false, status: 400, error: "This invoice is not linked to a job, so it has no hours to bill." };
  if (view.locked) return { ok: false, status: 400, error: "This invoice is paid or cancelled, so its lines can no longer change." };

  const built = buildHourLines(view.groups, choice);
  if (!built.ok) return { ok: false, status: 400, error: built.error };

  const { data, error } = await db.rpc("apply_invoice_hours", { p_invoice_id: invoiceId, p_lines: built.lines as any });
  if (error) {
    const status = error.code === "42501" ? 403 : error.code === "22023" || error.code === "P0002" ? 400 : 500;
    return { ok: false, status, error: error.message };
  }
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    lines: Number(r.lines ?? 0),
    entries: Number(r.entries ?? 0),
    hours: totalHours(view.groups),
    subtotal: Number(r.subtotal ?? 0),
    tax: Number(r.tax ?? 0),
    total: Number(r.total ?? 0),
  };
}
