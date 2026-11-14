import type { SupabaseClient } from "@supabase/supabase-js";
import { getRefreshedXero } from "@/lib/xero";

// A read-only local mirror of Xero's invoices, bills, payments and monthly
// profit & loss (draft migration 0098, not applied yet), so business questions run on our own database.
// Xero stays the record: nothing here writes back to Xero.
//
// RESUMABLE. Invoices and payments are read oldest-change-first
// (`UpdatedDateUTC ASC`) and the resume point is saved after every page, so a
// run that hits its time budget or Xero's rate limit just carries on next time.
// The first run is the backfill (24 months); every later run is the same loop
// starting at the saved point.

/** How far back the mirror reaches. */
export const HISTORY_MONTHS = 24;
/** Months re-read on every run: a closed month can still change (late bills, back-dated edits). */
export const PL_REFRESH_MONTHS = 3;

const PAGE_SIZE = 100;
const MAX_PAGES_PER_RUN = 200;

// ── Pure mapping (unit-tested) ───────────────────────────────────────────────

/** A Xero date (ISO string, "/Date(…)/"-parsed Date, or null) as `yyyy-mm-dd`. */
export function toDateOnly(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function toIso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export interface XeroInvoiceRow {
  xero_invoice_id: string;
  type: "ACCREC" | "ACCPAY";
  invoice_number: string | null;
  reference: string | null;
  xero_contact_id: string | null;
  contact_name: string | null;
  status: string;
  invoice_date: string | null;
  due_date: string | null;
  fully_paid_on: string | null;
  sub_total: number;
  total_tax: number;
  total: number;
  amount_due: number;
  amount_paid: number;
  currency_code: string | null;
  xero_updated_at: string | null;
}

/** The row a Xero invoice or bill becomes, or null when it has no id or an unknown type. */
export function invoiceRow(inv: any): XeroInvoiceRow | null {
  const type = String(inv?.type ?? "");
  if (!inv?.invoiceID || (type !== "ACCREC" && type !== "ACCPAY")) return null;
  return {
    xero_invoice_id: inv.invoiceID,
    type,
    invoice_number: inv.invoiceNumber ?? null,
    reference: inv.reference ?? null,
    xero_contact_id: inv.contact?.contactID ?? null,
    contact_name: inv.contact?.name ?? null,
    status: String(inv.status ?? "UNKNOWN"),
    invoice_date: toDateOnly(inv.date),
    due_date: toDateOnly(inv.dueDate),
    fully_paid_on: toDateOnly(inv.fullyPaidOnDate),
    sub_total: num(inv.subTotal),
    total_tax: num(inv.totalTax),
    total: num(inv.total),
    amount_due: num(inv.amountDue),
    amount_paid: num(inv.amountPaid),
    currency_code: inv.currencyCode ? String(inv.currencyCode) : null,
    xero_updated_at: toIso(inv.updatedDateUTC),
  };
}

export interface XeroPaymentRow {
  xero_payment_id: string;
  xero_invoice_id: string | null;
  payment_type: string | null;
  payment_date: string | null;
  amount: number;
  reference: string | null;
  status: string | null;
  account_code: string | null;
  xero_updated_at: string | null;
}

export function paymentRow(p: any): XeroPaymentRow | null {
  if (!p?.paymentID) return null;
  return {
    xero_payment_id: p.paymentID,
    xero_invoice_id: p.invoice?.invoiceID ?? null,
    payment_type: p.paymentType ? String(p.paymentType) : null,
    payment_date: toDateOnly(p.date),
    amount: num(p.amount),
    reference: p.reference ?? null,
    status: p.status ? String(p.status) : null,
    account_code: p.account?.code ?? null,
    xero_updated_at: toIso(p.updatedDateUTC),
  };
}

export interface PlRow {
  month: string; // first of the month, yyyy-mm-01
  section: string;
  account_name: string;
  xero_account_id: string | null;
  amount: number;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The calendar month a P&L column header names, as `yyyy-mm-01`. Xero labels
 * month columns by their end date ("30 Nov 2026"); "Nov 2026" and "Nov 26"
 * are accepted too. Throws on anything else, naming it, rather than filing a
 * month's figures under a guessed date.
 */
export function monthFromHeader(title: string): string {
  const t = title.trim();
  const full = [...t.matchAll(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?,?\s+(\d{2,4})/g)].pop();
  const short = [...t.matchAll(/([A-Za-z]{3})[A-Za-z]*\.?,?\s+(\d{2,4})/g)].pop();
  const m = full ? { mon: full[2], yr: full[3] } : short ? { mon: short[1], yr: short[2] } : null;
  const mi = m ? MONTHS.indexOf(m.mon.toLowerCase()) : -1;
  if (!m || mi < 0) throw new Error(`Unrecognised P&L column header "${title}"`);
  const year = m.yr.length === 2 ? 2000 + Number(m.yr) : Number(m.yr);
  return `${year}-${String(mi + 1).padStart(2, "0")}-01`;
}

/**
 * Flattens a Xero profit & loss report (one column per month) into one row per
 * account line per month. Header and total rows are skipped: totals are sums of
 * lines and are worked out when read, so they can never disagree with them.
 */
export function parsePlReport(report: any): PlRow[] {
  const rows: any[] = report?.rows ?? [];
  const header = rows.find((r) => String(r.rowType) === "Header");
  if (!header) throw new Error("P&L report has no header row");
  const months = (header.cells ?? []).slice(1).map((c: any) => monthFromHeader(String(c?.value ?? "")));

  const out: PlRow[] = [];
  for (const section of rows.filter((r) => String(r.rowType) === "Section")) {
    const title = String(section.title ?? "").trim();
    if (!title) continue; // summary-only sections (Gross / Net Profit)
    for (const row of (section.rows ?? []).filter((r: any) => String(r.rowType) === "Row")) {
      const cells: any[] = row.cells ?? [];
      const name = String(cells[0]?.value ?? "").trim();
      if (!name) continue;
      const accountId = (cells[0]?.attributes ?? []).find((a: any) => String(a.id) === "account")?.value ?? null;
      months.forEach((month: string, i: number) => {
        out.push({ month, section: title, account_name: name, xero_account_id: accountId, amount: num(cells[i + 1]?.value) });
      });
    }
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The first of the month `back` months before `anchor` (a Date), as yyyy-mm-01 — UTC arithmetic. */
export function monthStart(anchor: Date, back: number): string {
  const d = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - back, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;
}

/**
 * The P&L requests that cover `months` months ending in the month of `now`:
 * each asks for ONE month (the window's latest) plus 11 earlier — Xero's cap.
 */
export function plWindows(now: Date, months: number): { fromDate: string; toDate: string; periods: number }[] {
  const out: { fromDate: string; toDate: string; periods: number }[] = [];
  for (let back = 0; back < months; back += 12) {
    const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const last = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
    out.push({
      fromDate: `${anchor.getUTCFullYear()}-${pad(anchor.getUTCMonth() + 1)}-01`,
      toDate: `${last.getUTCFullYear()}-${pad(last.getUTCMonth() + 1)}-${pad(last.getUTCDate())}`,
      periods: Math.min(11, months - back - 1),
    });
  }
  return out;
}

export function isRateLimited(err: unknown): boolean {
  const e = err as any;
  return e?.response?.statusCode === 429 || e?.response?.status === 429 || e?.statusCode === 429 || /\b429\b/.test(String(e?.message ?? e));
}

// ── The sync ─────────────────────────────────────────────────────────────────

export interface EntityResult {
  rows: number;
  done: boolean;
  rateLimited?: boolean;
}

export interface AnalyticsSyncResult {
  invoices: EntityResult;
  payments: EntityResult;
  plMonths: number;
}

export class AnalyticsTablesMissing extends Error {
  constructor() {
    super("Xero analytics tables not found — apply migration 0098");
  }
}

const tableMissing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /relation .* does not exist|schema cache/i.test(e.message ?? ""));

function wrap(label: string, e: { code?: string; message: string }): Error {
  return tableMissing(e) ? new AnalyticsTablesMissing() : new Error(`${label} — ${e.message}`);
}

/**
 * Pulls invoices, bills, payments and the monthly P&L from Xero into the (draft,
 * not yet applied) 0098 tables. `admin` is a service-role client — callers authorise first (cron
 * secret or admin). Stops cleanly at `budgetMs` or at Xero's rate limit; the
 * saved resume point means the next run continues where this one stopped.
 */
export async function syncXeroAnalytics(
  admin: SupabaseClient,
  opts: { budgetMs?: number; now?: Date } = {}
): Promise<AnalyticsSyncResult> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? 40_000);
  const { xero, tenantId } = await getRefreshedXero(admin);

  const { data: stateRows, error: stateErr } = await admin.from("xero_sync_state").select("entity, cursor");
  if (stateErr) throw wrap("sync state read failed", stateErr);
  const cursorOf = (entity: string): Date | undefined => {
    const c = (stateRows ?? []).find((r: any) => r.entity === entity)?.cursor;
    return c ? new Date(c) : undefined;
  };

  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - HISTORY_MONTHS, 1));
  const where = `Date >= DateTime(${since.getUTCFullYear()}, ${since.getUTCMonth() + 1}, 1)`;

  const saveState = async (entity: string, patch: { cursor?: string | null; rows: number; error: string | null }) => {
    const row: Record<string, unknown> = { entity, last_run_at: new Date().toISOString(), last_rows: patch.rows, last_error: patch.error };
    if (patch.cursor !== undefined) row.cursor = patch.cursor;
    const { error } = await admin.from("xero_sync_state").upsert(row, { onConflict: "entity" });
    if (error) throw wrap("sync state write failed", error);
  };

  // Shared loop for the two paged, oldest-change-first entities.
  async function pull<T extends { xero_updated_at: string | null }>(
    entity: "invoices" | "payments",
    table: string,
    idColumn: string,
    fetchPage: (page: number, cursor: Date | undefined) => Promise<any[]>,
    toRow: (x: any) => T | null
  ): Promise<EntityResult> {
    const cursor = cursorOf(entity);
    let latest = cursor?.toISOString() ?? null;
    let total = 0;
    try {
      for (let page = 1; page <= MAX_PAGES_PER_RUN; page++) {
        if (Date.now() > deadline) {
          await saveState(entity, { cursor: latest, rows: total, error: null });
          return { rows: total, done: false };
        }
        const items = await fetchPage(page, cursor);
        const rows = items.map(toRow).filter((r): r is T => r !== null);
        if (rows.length > 0) {
          const { error } = await admin.from(table).upsert(rows.map((r) => ({ ...r, synced_at: new Date().toISOString() })), { onConflict: idColumn });
          if (error) throw wrap(`${table} write failed`, error);
          for (const r of rows) if (r.xero_updated_at && (!latest || r.xero_updated_at > latest)) latest = r.xero_updated_at;
          total += rows.length;
        }
        if (items.length < PAGE_SIZE) {
          await saveState(entity, { cursor: latest, rows: total, error: null });
          return { rows: total, done: true };
        }
      }
      await saveState(entity, { cursor: latest, rows: total, error: null });
      return { rows: total, done: false };
    } catch (err) {
      if (isRateLimited(err)) {
        await saveState(entity, { cursor: latest, rows: total, error: "Xero rate limit — will resume next run" });
        return { rows: total, done: false, rateLimited: true };
      }
      const message = err instanceof Error ? err.message : String(err);
      await saveState(entity, { rows: total, error: message.slice(0, 500) }).catch(() => {});
      throw err;
    }
  }

  const invoices = await pull(
    "invoices",
    "xero_invoices",
    "xero_invoice_id",
    async (page, cursor) => {
      const res = await xero.accountingApi.getInvoices(
        tenantId, cursor, where, "UpdatedDateUTC ASC", undefined, undefined, undefined, undefined,
        page, false, false, undefined, true, PAGE_SIZE
      );
      return res.body.invoices ?? [];
    },
    invoiceRow
  );

  const payments = await pull(
    "payments",
    "xero_payments",
    "xero_payment_id",
    async (page, cursor) => {
      const res = await xero.accountingApi.getPayments(tenantId, cursor, where, "UpdatedDateUTC ASC", page, PAGE_SIZE);
      return res.body.payments ?? [];
    },
    paymentRow
  );

  // P&L: a full backfill while the table is empty, then only the recent months.
  let plMonths = 0;
  if (Date.now() < deadline) {
    const { count, error: countErr } = await admin.from("xero_pl_monthly").select("month", { count: "exact", head: true });
    if (countErr) throw wrap("P&L read failed", countErr);
    const months = (count ?? 0) === 0 ? HISTORY_MONTHS : PL_REFRESH_MONTHS;
    try {
      for (const w of plWindows(now, months)) {
        const res = await xero.accountingApi.getReportProfitAndLoss(tenantId, w.fromDate, w.toDate, w.periods, "MONTH", undefined, undefined, undefined, undefined, true, false);
        const report = res.body.reports?.[0];
        const rows = parsePlReport(report);
        if (rows.length > 0) {
          const { error } = await admin
            .from("xero_pl_monthly")
            .upsert(rows.map((r) => ({ ...r, synced_at: new Date().toISOString() })), { onConflict: "month,section,account_name" });
          if (error) throw wrap("P&L write failed", error);
        }
        plMonths += new Set(rows.map((r) => r.month)).size;
      }
      await saveState("pl_monthly", { cursor: new Date().toISOString(), rows: plMonths, error: null });
    } catch (err) {
      if (!isRateLimited(err)) {
        const message = err instanceof Error ? err.message : String(err);
        await saveState("pl_monthly", { rows: plMonths, error: message.slice(0, 500) }).catch(() => {});
        throw err;
      }
      await saveState("pl_monthly", { rows: plMonths, error: "Xero rate limit — will resume next run" });
    }
  }

  return { invoices, payments, plMonths };
}
