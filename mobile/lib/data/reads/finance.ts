import { supabase } from "../../supabase";

// The read-repository layer: the ONLY place screens get financial data. Screens
// never call supabase directly, so a future offline cache (PowerSync or a
// persisted store) can swap these bodies without touching a single screen.
// (Per Avi's "read-repository layer now" decision, D29.)

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

export async function listInvoices(offset: number, limit: number): Promise<InvoiceListRow[]> {
  const { data } = await supabase
    .from("invoices")
    .select(INVOICE_LIST)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false }) // stable tiebreaker over non-unique created_at
    .range(offset, offset + limit - 1);
  return (data as unknown as InvoiceListRow[]) ?? [];
}

export async function getInvoice(id: string): Promise<InvoiceDetail | null> {
  const { data } = await supabase
    .from("invoices")
    .select("*, customers(name, email, phone), invoice_items(*)")
    .eq("id", id)
    .single();
  return (data as unknown as InvoiceDetail) ?? null;
}

// The web invoices page's two extra "ready to invoice" sources (jobs + approved
// variations) so unbilled work still surfaces on mobile.
export async function listReadyToInvoice(): Promise<{ jobs: ReadyJob[]; variations: ReadyVariation[] }> {
  const [jobsRes, varsRes] = await Promise.all([
    supabase.from("jobs").select("id, job_number, title, customers(name)").eq("ready_to_invoice", true).order("updated_at", { ascending: false }),
    supabase.from("job_variations").select("id, total_amount, jobs(id, job_number, title, customers(name))").in("status", ["approved", "auto_approved"]).is("invoice_id", null),
  ]);
  return {
    jobs: (jobsRes.data as unknown as ReadyJob[]) ?? [],
    variations: (varsRes.data as unknown as ReadyVariation[]) ?? [],
  };
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
  const [jobRes, itemsRes, varsRes] = await Promise.all([
    supabase.from("jobs").select("customer_id, title, completion_notes, voice_report_transcript, customers(name)").eq("id", jobId).single(),
    supabase.from("job_items").select("name, description, quantity, unit_price").eq("job_id", jobId).order("created_at"),
    supabase.from("job_variations").select("id, custom_name, quantity, unit, rate, total_amount, variation_types(name)").eq("job_id", jobId).in("status", ["approved", "auto_approved"]).is("invoice_id", null),
  ]);
  const job = jobRes.data as { customer_id: string; title: string; completion_notes: string | null; voice_report_transcript: string | null; customers: { name: string } | null } | null;
  if (!job) return null;

  type ItemRow = { name: string; description: string | null; quantity: number; unit_price: number };
  const items = ((itemsRes.data as unknown as ItemRow[]) ?? []).map((i) => ({
    name: i.name,
    description: i.description ?? null,
    quantity: Number(i.quantity),
    unitPrice: Number(i.unit_price),
  }));

  type VarRow = { id: string; custom_name: string | null; quantity: number; unit: string | null; rate: number | null; total_amount: number | null; variation_types: { name: string } | null };
  const unbilledVariations = ((varsRes.data as unknown as VarRow[]) ?? []).map((v) => ({
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
}

export async function listQuotes(offset: number, limit: number): Promise<QuoteListRow[]> {
  const { data } = await supabase
    .from("quotes")
    .select(QUOTE_LIST)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);
  return (data as unknown as QuoteListRow[]) ?? [];
}

export async function getQuote(id: string): Promise<QuoteDetail | null> {
  const { data } = await supabase
    .from("quotes")
    .select("*, customers(name, email, phone), quote_items(*)")
    .eq("id", id)
    .single();
  return (data as unknown as QuoteDetail) ?? null;
}

export async function listPricing(): Promise<PricingItem[]> {
  const { data } = await supabase
    .from("pricing_items")
    .select("id, name, description, category, pricing_type, unit_price, unit")
    .eq("is_active", true)
    .order("category")
    .order("name");
  return (data as unknown as PricingItem[]) ?? [];
}

// Deactivated catalogue items — for the "Show inactive" view where they can be
// reactivated (they're hidden from the main list + the invoice/quote pickers).
export async function listInactivePricing(): Promise<PricingItem[]> {
  const { data } = await supabase
    .from("pricing_items")
    .select("id, name, description, category, pricing_type, unit_price, unit")
    .eq("is_active", false)
    .order("category")
    .order("name");
  return (data as unknown as PricingItem[]) ?? [];
}
