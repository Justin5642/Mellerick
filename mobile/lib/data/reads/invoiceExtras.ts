import { supabase } from "../../supabase";
import { fromLocalOr, type RouteOptions } from "./source";
import { nestOne, num, numOrNull } from "./rowMap";
import { unwrap, unwrapRows } from "./unwrap";
import { OWED_STATUSES, type OwedInvoice } from "../../invoicePayments";

// Office reads behind the phone's invoice actions: "Owed to us", the job's
// builder POs for New / Edit Invoice, and the previous progress claim.
//
// SYNC WINDOW (0068): an invoice that is not paid or cancelled is always on an
// office device, so the owed list is complete locally by construction.
// purchase_orders / po_cost_centers sync whole to office devices (one row set
// per job, not windowed), so a job's POs are complete locally too. The
// previous claim is NOT: a paid claim from long ago may be outside the
// window — that read goes to Supabase only.

const OFFICE_ADMIN: RouteOptions = { roles: ["office", "admin"] };

// ── Owed to us ──────────────────────────────────────────────────────────────

export const SQL_OWED_INVOICES = `
  SELECT i.id, i.invoice_number, i.title, i.total, i.amount_paid, i.due_date, i.status,
         c.name AS customer_name
  FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
  WHERE i.status IN ('sent','overdue')`;

type RawOwedRow = {
  id: string;
  invoice_number: number | string;
  title: string;
  total: number | string | null;
  amount_paid: number | string | null;
  due_date: string | null;
  status: string;
  customer_name: string | null;
};

/** Every sent or overdue invoice, with what it has been paid — the web's "Owed to us" query. */
export async function listOwedInvoices(): Promise<OwedInvoice[]> {
  return fromLocalOr(
    async (db) => {
      const rows = await db.getAll<RawOwedRow>(SQL_OWED_INVOICES, []);
      return rows.map((r) => ({
        id: r.id,
        invoice_number: num(r.invoice_number),
        title: r.title,
        total: numOrNull(r.total),
        amount_paid: numOrNull(r.amount_paid),
        due_date: r.due_date,
        status: r.status,
        customers: nestOne(r.customer_name, { name: r.customer_name }),
      }));
    },
    async () => {
      const res = await supabase
        .from("invoices")
        .select("id, invoice_number, title, total, amount_paid, due_date, status, customers(name)")
        .in("status", OWED_STATUSES);
      return (unwrapRows(res as never, "listOwedInvoices") as unknown as OwedInvoice[]).map((r) => ({
        ...r,
        total: r.total == null ? null : Number(r.total),
        amount_paid: r.amount_paid == null ? null : Number(r.amount_paid),
      }));
    },
    OFFICE_ADMIN
  );
}

// ── The job's builder POs ───────────────────────────────────────────────────

export interface InvoicePo {
  id: string;
  po_number: string;
  total_value: number;
  lines: { name: string; allocated_amount: number | null; sort_order: number | null }[];
}

export interface InvoiceJobPos {
  /** The job's own PO number (jobs.customer_po, 0083) — the invoice's default. */
  customerPo: string | null;
  /** Every PO on the job, oldest first, with its cost-centre lines. */
  pos: InvoicePo[];
}

export const SQL_INVOICE_JOB_CUSTOMER_PO = `SELECT customer_po FROM jobs WHERE id = ?`;

export const SQL_INVOICE_JOB_POS = `
  SELECT id, po_number, total_value FROM purchase_orders WHERE job_id = ? ORDER BY created_at, id`;

export const SQL_INVOICE_JOB_PO_LINES = `
  SELECT cc.po_id, cc.name, cc.allocated_amount, cc.sort_order
  FROM po_cost_centers cc JOIN purchase_orders po ON po.id = cc.po_id
  WHERE po.job_id = ?
  ORDER BY cc.sort_order, cc.name`;

type RawPoRow = { id: string; po_number: string; total_value: number | string | null };
type RawPoLineRow = { po_id: string; name: string; allocated_amount: number | string | null; sort_order: number | string | null };

function assemble(customerPo: string | null, pos: RawPoRow[], lines: RawPoLineRow[]): InvoiceJobPos {
  return {
    customerPo,
    pos: pos.map((p) => ({
      id: p.id,
      po_number: p.po_number,
      total_value: num(p.total_value),
      lines: lines
        .filter((l) => l.po_id === p.id)
        .map((l) => ({ name: l.name, allocated_amount: numOrNull(l.allocated_amount), sort_order: numOrNull(l.sort_order) })),
    })),
  };
}

export async function getInvoiceJobPos(jobId: string): Promise<InvoiceJobPos> {
  return fromLocalOr(
    async (db) => {
      const [job, pos, lines] = await Promise.all([
        db.getOptional<{ customer_po: string | null }>(SQL_INVOICE_JOB_CUSTOMER_PO, [jobId]),
        db.getAll<RawPoRow>(SQL_INVOICE_JOB_POS, [jobId]),
        db.getAll<RawPoLineRow>(SQL_INVOICE_JOB_PO_LINES, [jobId]),
      ]);
      return assemble(job?.customer_po ?? null, pos, lines);
    },
    async () => {
      const [jobRes, posRes] = await Promise.all([
        supabase.from("jobs").select("customer_po").eq("id", jobId).maybeSingle(),
        supabase
          .from("purchase_orders")
          .select("id, po_number, total_value, po_cost_centers(po_id, name, allocated_amount, sort_order)")
          .eq("job_id", jobId)
          .order("created_at")
          .order("id"),
      ]);
      const job = unwrap(jobRes as never, "getInvoiceJobPos(job)") as unknown as { customer_po: string | null } | null;
      const rows = unwrapRows(posRes as never, "getInvoiceJobPos(pos)") as unknown as (RawPoRow & { po_cost_centers: RawPoLineRow[] | null })[];
      const lines = rows
        .flatMap((p) => p.po_cost_centers ?? [])
        .sort((a, b) => num(a.sort_order) - num(b.sort_order) || a.name.localeCompare(b.name));
      return assemble(job?.customer_po ?? null, rows, lines);
    },
    OFFICE_ADMIN
  );
}

/**
 * The number of an invoice already raised on the job for this builder PO, "yes"
 * when it has none, or null when there is no such invoice. Supabase only: the
 * earlier invoice may be outside the window.
 */
export async function findInvoiceForPo(jobId: string, poNumber: string): Promise<string | null> {
  const res = await supabase.from("invoices").select("invoice_number").eq("job_id", jobId).eq("customer_po", poNumber).limit(1);
  const rows = unwrapRows(res as never, "findInvoiceForPo") as unknown as { invoice_number: number | null }[];
  if (rows.length === 0) return null;
  return rows[0].invoice_number != null ? String(rows[0].invoice_number) : "yes";
}

// ── The previous progress claim (Supabase only — see the header) ───────────

export interface PreviousClaim {
  claim_number: number | null;
  claim_contract_value: number | null;
  claim_previous: number | null;
  subtotal: number | null;
}

/**
 * The job's latest progress claim — on one builder PO when given — leaving out
 * the invoice being edited. The web's ProgressClaimFields query.
 */
export async function getPreviousClaim(
  jobId: string,
  opts: { excludeInvoiceId?: string | null; poNumber?: string | null } = {}
): Promise<PreviousClaim | null> {
  let q = supabase
    .from("invoices")
    .select("claim_number, claim_contract_value, claim_previous, subtotal")
    .eq("job_id", jobId)
    .eq("is_progress_claim", true)
    .order("claim_number", { ascending: false })
    .limit(1);
  if (opts.excludeInvoiceId) q = q.neq("id", opts.excludeInvoiceId);
  if (opts.poNumber) q = q.eq("customer_po", opts.poNumber);
  const rows = unwrapRows((await q) as never, "getPreviousClaim") as unknown as PreviousClaim[];
  const r = rows[0];
  if (!r) return null;
  return {
    claim_number: r.claim_number == null ? null : Number(r.claim_number),
    claim_contract_value: r.claim_contract_value == null ? null : Number(r.claim_contract_value),
    claim_previous: r.claim_previous == null ? null : Number(r.claim_previous),
    subtotal: r.subtotal == null ? null : Number(r.subtotal),
  };
}
