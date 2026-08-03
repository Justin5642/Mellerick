import { supabase } from "../../supabase";
import { fromLocalOr, type RouteOptions } from "./source";
import { nestOne, num, numOrNull } from "./rowMap";
import { unwrap, unwrapRows } from "./unwrap";

// The read-repository layer: the ONLY place screens get financial data. Screens
// never call supabase directly, so a future offline cache (PowerSync or a
// persisted store) can swap these bodies without touching a single screen.
// (Per Avi's "read-repository layer now" decision, D29.)
//
// Each read routes through fromLocalOr: the local closure runs the SQL below
// against the device's PowerSync SQLite mirror; the remote closure is the
// original Supabase body, kept byte-identical so the fallback matches today's
// behaviour exactly.
//
// GENERATED-COLUMN TRAP: invoice_items.total, quote_items.total and
// job_items.total are `generated always as (quantity * unit_price) stored` and
// logical replication does NOT publish generated columns — locally they arrive
// NULL. Every local statement over those tables computes
// ROUND(quantity * unit_price, 2) AS total and never selects the bare column.
// (invoices.total / quotes.total are plain decimals and replicate fine.)

export interface InvoiceListRow {
  id: string;
  invoice_number: number | string;
  title: string;
  total: number | null;
  status: string;
  due_date: string | null;
  customers: { name: string } | null;
}
export interface InvoiceItem {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  unit_price: number;
  total: number;
}
export interface InvoiceDetail {
  id: string;
  invoice_number: number | string;
  title: string;
  status: string;
  subtotal: number | null;
  tax_amount: number | null;
  total: number | null;
  due_date: string | null;
  created_at: string;
  notes: string | null;
  work_description: string | null;
  xero_invoice_id: string | null;
  customers: { name: string; email: string | null; phone: string | null } | null;
  invoice_items: InvoiceItem[];
}
export interface ReadyJob {
  id: string;
  job_number: number;
  title: string;
  customers: { name: string } | null;
}
export interface ReadyVariation {
  id: string;
  total_amount: number | null;
  jobs: { id: string; job_number: number; title: string; customers: { name: string } | null } | null;
}
export interface QuoteListRow {
  id: string;
  quote_number: number | string;
  title: string;
  total: number | null;
  status: string;
  valid_until: string | null;
  customers: { name: string } | null;
}
export interface QuoteItem {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  unit_price: number;
  total: number;
}
export interface QuoteDetail {
  id: string;
  quote_number: number | string;
  title: string;
  status: string;
  subtotal: number | null;
  tax_amount: number | null;
  total: number | null;
  valid_until: string | null;
  created_at: string;
  notes: string | null;
  customer_id: string;
  site_id: string | null;
  job_id: string | null; // set once the quote has been converted to a job
  customers: { name: string; email: string | null; phone: string | null } | null;
  quote_items: QuoteItem[];
}
export interface PricingItem {
  id: string;
  name: string;
  description: string | null;
  category: string;
  pricing_type: string;
  unit_price: number;
  unit: string | null;
}

const INVOICE_LIST = "id, invoice_number, title, total, status, due_date, customers(name)";
const QUOTE_LIST = "id, quote_number, title, total, status, valid_until, customers(name)";

// Finance is office/admin-only. Any other (or unknown) role routes to
// Supabase, where RLS answers loudly instead of a silently-empty local table.
const OFFICE_ADMIN: RouteOptions = { roles: ["office", "admin"] };

// ---------------------------------------------------------------------------
// Local SQL. Exported as named consts so sqlLint.test.ts can scan them.
// ---------------------------------------------------------------------------

export const SQL_LIST_INVOICES = `
  SELECT i.id, i.invoice_number, i.title, i.total, i.status, i.due_date, c.name AS customer_name
  FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
  ORDER BY i.created_at DESC, i.id DESC
  LIMIT ? OFFSET ?`;

export const SQL_LIST_QUOTES = `
  SELECT q.id, q.quote_number, q.title, q.total, q.status, q.valid_until, c.name AS customer_name
  FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id
  ORDER BY q.created_at DESC, q.id DESC
  LIMIT ? OFFSET ?`;

export const SQL_GET_INVOICE = `
  SELECT id, invoice_number, title, status, subtotal, tax_amount, total, due_date,
         created_at, notes, work_description, xero_invoice_id,
         (SELECT name  FROM customers WHERE id = invoices.customer_id) AS customer_name,
         (SELECT email FROM customers WHERE id = invoices.customer_id) AS customer_email,
         (SELECT phone FROM customers WHERE id = invoices.customer_id) AS customer_phone
  FROM invoices WHERE id = ?`;

// ORDER BY here is a deliberate divergence from PostgREST (which leaves embed
// order unspecified): deterministic line-item order is strictly better.
export const SQL_GET_INVOICE_ITEMS = `
  SELECT id, name, description, quantity, unit_price,
         ROUND(quantity * unit_price, 2) AS total
  FROM invoice_items WHERE invoice_id = ? ORDER BY created_at, id`;

export const SQL_GET_QUOTE = `
  SELECT id, quote_number, title, status, subtotal, tax_amount, total, valid_until,
         created_at, notes, customer_id, site_id, job_id,
         (SELECT name  FROM customers WHERE id = quotes.customer_id) AS customer_name,
         (SELECT email FROM customers WHERE id = quotes.customer_id) AS customer_email,
         (SELECT phone FROM customers WHERE id = quotes.customer_id) AS customer_phone
  FROM quotes WHERE id = ?`;

export const SQL_GET_QUOTE_ITEMS = `
  SELECT id, name, description, quantity, unit_price,
         ROUND(quantity * unit_price, 2) AS total
  FROM quote_items WHERE quote_id = ? ORDER BY created_at, id`;

// jobs.ready_to_invoice is created by migration 0040. It was previously believed
// to be "prod drift, confirmed boolean in prod" — that comment was wrong: the
// column did not exist at all, so every read and write naming it failed. Verified
// against the live database 2026-07-28 (ERROR 42703) and fixed by 0040.
export const SQL_READY_JOBS = `
  SELECT j.id, j.job_number, j.title, c.name AS customer_name
  FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id
  WHERE j.ready_to_invoice = 1
  ORDER BY j.updated_at DESC`;

export const SQL_READY_VARIATIONS = `
  SELECT v.id, v.total_amount, j.id AS job_id, j.job_number, j.title AS job_title,
         c.name AS customer_name
  FROM job_variations v
  LEFT JOIN jobs j      ON j.id = v.job_id
  LEFT JOIN customers c ON c.id = j.customer_id
  WHERE v.status IN ('approved','auto_approved') AND v.invoice_id IS NULL`;

export const SQL_PREFILL_JOB = `
  SELECT j.customer_id, j.title, j.completion_notes, j.voice_report_transcript,
         c.name AS customer_name
  FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id WHERE j.id = ?`;

export const SQL_PREFILL_JOB_ITEMS = `
  SELECT name, description, quantity, unit_price FROM job_items WHERE job_id = ? ORDER BY created_at, id`;

// Only t.name is read from variation_types, so the rate-stripped stream is fine.
export const SQL_PREFILL_VARIATIONS = `
  SELECT v.id, v.custom_name, v.quantity, v.unit, v.rate, v.total_amount,
         t.name AS variation_type_name
  FROM job_variations v LEFT JOIN variation_types t ON t.id = v.variation_type_id
  WHERE v.job_id = ? AND v.status IN ('approved','auto_approved') AND v.invoice_id IS NULL`;

// Shared by listPricing (param 1) and listInactivePricing (param 0).
// pricing_items.category is NOT NULL, so no IS NULL ordering prefix is needed.
export const SQL_PRICING = `
  SELECT id, name, description, category, pricing_type, unit_price, unit
  FROM pricing_items
  WHERE is_active = ?
  ORDER BY category COLLATE NOCASE, name COLLATE NOCASE`;

// ---------------------------------------------------------------------------
// SQLite-shaped row types + mappers back to the PostgREST shapes.
// ---------------------------------------------------------------------------

type RawInvoiceListRow = {
  id: string;
  invoice_number: number | string;
  title: string;
  total: number | string | null;
  status: string;
  due_date: string | null;
  customer_name: string | null;
};

type RawQuoteListRow = {
  id: string;
  quote_number: number | string;
  title: string;
  total: number | string | null;
  status: string;
  valid_until: string | null;
  customer_name: string | null;
};

type RawItemRow = {
  id: string;
  name: string;
  description: string | null;
  quantity: number | string;
  unit_price: number | string;
  total: number | string; // computed by the SQL, never the generated column
};

type RawInvoiceDetailRow = {
  id: string;
  invoice_number: number | string;
  title: string;
  status: string;
  subtotal: number | string | null;
  tax_amount: number | string | null;
  total: number | string | null;
  due_date: string | null;
  created_at: string;
  notes: string | null;
  work_description: string | null;
  xero_invoice_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
};

type RawQuoteDetailRow = {
  id: string;
  quote_number: number | string;
  title: string;
  status: string;
  subtotal: number | string | null;
  tax_amount: number | string | null;
  total: number | string | null;
  valid_until: string | null;
  created_at: string;
  notes: string | null;
  customer_id: string;
  site_id: string | null;
  job_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
};

type RawReadyJobRow = {
  id: string;
  job_number: number | string;
  title: string;
  customer_name: string | null;
};

type RawReadyVariationRow = {
  id: string;
  total_amount: number | string | null;
  job_id: string | null;
  job_number: number | string | null;
  job_title: string | null;
  customer_name: string | null;
};

type RawPrefillJobRow = {
  customer_id: string;
  title: string;
  completion_notes: string | null;
  voice_report_transcript: string | null;
  customer_name: string | null;
};

type RawPrefillItemRow = {
  name: string;
  description: string | null;
  quantity: number | string;
  unit_price: number | string;
};

type RawPrefillVariationRow = {
  id: string;
  custom_name: string | null;
  quantity: number | string;
  unit: string | null;
  rate: number | string | null;
  total_amount: number | string | null;
  variation_type_name: string | null;
};

type RawPricingRow = {
  id: string;
  name: string;
  description: string | null;
  category: string;
  pricing_type: string;
  unit_price: number | string;
  unit: string | null;
};

function mapItemRow(r: RawItemRow): InvoiceItem {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    quantity: num(r.quantity),
    unit_price: num(r.unit_price),
    total: num(r.total),
  };
}

function mapPricingRow(r: RawPricingRow): PricingItem {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    category: r.category,
    pricing_type: r.pricing_type,
    unit_price: num(r.unit_price),
    unit: r.unit,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listInvoices(offset: number, limit: number): Promise<InvoiceListRow[]> {
  return fromLocalOr(
    async (db) => {
      const rows = await db.getAll<RawInvoiceListRow>(SQL_LIST_INVOICES, [limit, offset]);
      return rows.map((r) => ({
        id: r.id,
        invoice_number: r.invoice_number,
        title: r.title,
        total: numOrNull(r.total),
        status: r.status,
        due_date: r.due_date,
        customers: nestOne(r.customer_name, { name: r.customer_name as string }),
      }));
    },
    async () => {
      const res = await supabase
        .from("invoices")
        .select(INVOICE_LIST)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false }) // stable tiebreaker over non-unique created_at
        .range(offset, offset + limit - 1);
      return unwrapRows(res as never, "listInvoices") as unknown as InvoiceListRow[];
    },
    OFFICE_ADMIN
  );
}

export async function getInvoice(id: string): Promise<InvoiceDetail | null> {
  return fromLocalOr(
    async (db) => {
      const inv = await db.getOptional<RawInvoiceDetailRow>(SQL_GET_INVOICE, [id]);
      if (!inv) return null;
      const items = await db.getAll<RawItemRow>(SQL_GET_INVOICE_ITEMS, [id]);
      return {
        id: inv.id,
        invoice_number: inv.invoice_number,
        title: inv.title,
        status: inv.status,
        subtotal: numOrNull(inv.subtotal),
        tax_amount: numOrNull(inv.tax_amount),
        total: numOrNull(inv.total),
        due_date: inv.due_date,
        created_at: inv.created_at,
        notes: inv.notes,
        work_description: inv.work_description,
        xero_invoice_id: inv.xero_invoice_id,
        customers: nestOne(inv.customer_name, {
          name: inv.customer_name as string,
          email: inv.customer_email,
          phone: inv.customer_phone,
        }),
        invoice_items: items.map(mapItemRow),
      };
    },
    async () => {
      const res = await supabase
        .from("invoices")
        .select("*, customers(name, email, phone), invoice_items(*)")
        .eq("id", id)
        .single();
      return unwrap(res as never, "getInvoice") as unknown as InvoiceDetail | null;
    },
    OFFICE_ADMIN
  );
}

// The web invoices page's two extra "ready to invoice" sources (jobs + approved
// variations) so unbilled work still surfaces on mobile.
export async function listReadyToInvoice(): Promise<{ jobs: ReadyJob[]; variations: ReadyVariation[] }> {
  return fromLocalOr(
    async (db) => {
      const [jobRows, varRows] = await Promise.all([
        db.getAll<RawReadyJobRow>(SQL_READY_JOBS),
        db.getAll<RawReadyVariationRow>(SQL_READY_VARIATIONS),
      ]);
      return {
        jobs: jobRows.map((j) => ({
          id: j.id,
          job_number: num(j.job_number),
          title: j.title,
          customers: nestOne(j.customer_name, { name: j.customer_name as string }),
        })),
        variations: varRows.map((v) => ({
          id: v.id,
          total_amount: numOrNull(v.total_amount),
          jobs: nestOne(v.job_id, {
            id: v.job_id as string,
            job_number: num(v.job_number),
            title: v.job_title as string,
            customers: nestOne(v.customer_name, { name: v.customer_name as string }),
          }),
        })),
      };
    },
    async () => {
      const [jobsRes, varsRes] = await Promise.all([
        supabase.from("jobs").select("id, job_number, title, customers(name)").eq("ready_to_invoice", true).order("updated_at", { ascending: false }),
        supabase.from("job_variations").select("id, total_amount, jobs(id, job_number, title, customers(name))").in("status", ["approved", "auto_approved"]).is("invoice_id", null),
      ]);
      return {
        jobs: unwrapRows(jobsRes as never, "listReadyToInvoice(jobs)") as unknown as ReadyJob[],
        variations: unwrapRows(varsRes as never, "listReadyToInvoice(variations)") as unknown as ReadyVariation[],
      };
    },
    OFFICE_ADMIN
  );
}

export interface InvoiceJobPrefill {
  customerId: string;
  customerName: string | null;
  title: string;
  workDescription: string | null;
  items: { name: string; description: string | null; quantity: number; unitPrice: number }[];
  unbilledVariations: { id: string; name: string; description: string; unitPrice: number }[];
}

// "Create invoice from job" prefill — mirrors the web invoices/new. Line items
// come from the job's built-up job_items (NOTE: unlike the web this does not
// first call /api/jobs/[id]/sync-billing — that route is cookie-only and rejects
// a mobile Bearer token, an external gate; items may be slightly stale). Unbilled
// approved variations are offered to add; work description prefers the completion
// notes then the voice-report transcript.
export async function getInvoiceJobPrefill(jobId: string): Promise<InvoiceJobPrefill | null> {
  return fromLocalOr(
    async (db) => {
      const [job, itemRows, varRows] = await Promise.all([
        db.getOptional<RawPrefillJobRow>(SQL_PREFILL_JOB, [jobId]),
        db.getAll<RawPrefillItemRow>(SQL_PREFILL_JOB_ITEMS, [jobId]),
        db.getAll<RawPrefillVariationRow>(SQL_PREFILL_VARIATIONS, [jobId]),
      ]);
      if (!job) return null;
      return {
        customerId: job.customer_id,
        customerName: job.customer_name ?? null,
        title: job.title,
        workDescription: (job.completion_notes || job.voice_report_transcript || "").trim() || null,
        items: itemRows.map((i) => ({
          name: i.name,
          description: i.description ?? null,
          quantity: num(i.quantity),
          unitPrice: num(i.unit_price),
        })),
        unbilledVariations: varRows.map((v) => ({
          id: v.id,
          name: v.variation_type_name ?? v.custom_name ?? "Variation",
          description: `${num(v.quantity)} ${v.unit ?? ""}${v.rate != null ? ` @ $${num(v.rate).toFixed(2)}` : ""}`.trim(),
          unitPrice: numOrNull(v.total_amount) ?? num(v.rate) * num(v.quantity),
        })),
      };
    },
    async () => {
      const [jobRes, itemsRes, varsRes] = await Promise.all([
        supabase.from("jobs").select("customer_id, title, completion_notes, voice_report_transcript, customers(name)").eq("id", jobId).single(),
        supabase.from("job_items").select("name, description, quantity, unit_price").eq("job_id", jobId).order("created_at"),
        supabase.from("job_variations").select("id, custom_name, quantity, unit, rate, total_amount, variation_types(name)").eq("job_id", jobId).in("status", ["approved", "auto_approved"]).is("invoice_id", null),
      ]);
      const job = unwrap(jobRes as never, "getInvoiceJobPrefill(job)") as unknown as { customer_id: string; title: string; completion_notes: string | null; voice_report_transcript: string | null; customers: { name: string } | null } | null;
      if (!job) return null;

      type ItemRow = { name: string; description: string | null; quantity: number; unit_price: number };
      const items = (unwrapRows(itemsRes as never, "getInvoiceJobPrefill(items)") as unknown as ItemRow[]).map((i) => ({
        name: i.name,
        description: i.description ?? null,
        quantity: Number(i.quantity),
        unitPrice: Number(i.unit_price),
      }));

      type VarRow = { id: string; custom_name: string | null; quantity: number; unit: string | null; rate: number | null; total_amount: number | null; variation_types: { name: string } | null };
      const unbilledVariations = (unwrapRows(varsRes as never, "getInvoiceJobPrefill(variations)") as unknown as VarRow[]).map((v) => ({
        id: v.id,
        name: v.variation_types?.name ?? v.custom_name ?? "Variation",
        description: `${v.quantity} ${v.unit ?? ""}${v.rate != null ? ` @ $${Number(v.rate).toFixed(2)}` : ""}`.trim(),
        unitPrice: Number(v.total_amount ?? Number(v.rate ?? 0) * Number(v.quantity)),
      }));

      return {
        customerId: job.customer_id,
        customerName: job.customers?.name ?? null,
        title: job.title,
        workDescription: (job.completion_notes || job.voice_report_transcript || "").trim() || null,
        items,
        unbilledVariations,
      };
    },
    OFFICE_ADMIN
  );
}

export async function listQuotes(offset: number, limit: number): Promise<QuoteListRow[]> {
  return fromLocalOr(
    async (db) => {
      const rows = await db.getAll<RawQuoteListRow>(SQL_LIST_QUOTES, [limit, offset]);
      return rows.map((r) => ({
        id: r.id,
        quote_number: r.quote_number,
        title: r.title,
        total: numOrNull(r.total),
        status: r.status,
        valid_until: r.valid_until,
        customers: nestOne(r.customer_name, { name: r.customer_name as string }),
      }));
    },
    async () => {
      const res = await supabase
        .from("quotes")
        .select(QUOTE_LIST)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + limit - 1);
      return unwrapRows(res as never, "listQuotes") as unknown as QuoteListRow[];
    },
    OFFICE_ADMIN
  );
}

export async function getQuote(id: string): Promise<QuoteDetail | null> {
  return fromLocalOr(
    async (db) => {
      const q = await db.getOptional<RawQuoteDetailRow>(SQL_GET_QUOTE, [id]);
      if (!q) return null;
      const items = await db.getAll<RawItemRow>(SQL_GET_QUOTE_ITEMS, [id]);
      return {
        id: q.id,
        quote_number: q.quote_number,
        title: q.title,
        status: q.status,
        subtotal: numOrNull(q.subtotal),
        tax_amount: numOrNull(q.tax_amount),
        total: numOrNull(q.total),
        valid_until: q.valid_until,
        created_at: q.created_at,
        notes: q.notes,
        customer_id: q.customer_id,
        site_id: q.site_id,
        job_id: q.job_id,
        customers: nestOne(q.customer_name, {
          name: q.customer_name as string,
          email: q.customer_email,
          phone: q.customer_phone,
        }),
        quote_items: items.map(mapItemRow),
      };
    },
    async () => {
      const res = await supabase
        .from("quotes")
        .select("*, customers(name, email, phone), quote_items(*)")
        .eq("id", id)
        .single();
      return unwrap(res as never, "getQuote") as unknown as QuoteDetail | null;
    },
    OFFICE_ADMIN
  );
}

export async function listPricing(): Promise<PricingItem[]> {
  return fromLocalOr(
    async (db) => (await db.getAll<RawPricingRow>(SQL_PRICING, [1])).map(mapPricingRow),
    async () => {
      const res = await supabase
        .from("pricing_items")
        .select("id, name, description, category, pricing_type, unit_price, unit")
        .eq("is_active", true)
        .order("category")
        .order("name");
      return unwrapRows(res as never, "listPricing") as unknown as PricingItem[];
    },
    OFFICE_ADMIN
  );
}

// Deactivated catalogue items — for the "Show inactive" view where they can be
// reactivated (they're hidden from the main list + the invoice/quote pickers).
export async function listInactivePricing(): Promise<PricingItem[]> {
  return fromLocalOr(
    async (db) => (await db.getAll<RawPricingRow>(SQL_PRICING, [0])).map(mapPricingRow),
    async () => {
      const res = await supabase
        .from("pricing_items")
        .select("id, name, description, category, pricing_type, unit_price, unit")
        .eq("is_active", false)
        .order("category")
        .order("name");
      return unwrapRows(res as never, "listInactivePricing") as unknown as PricingItem[];
    },
    OFFICE_ADMIN
  );
}
