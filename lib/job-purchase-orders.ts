import type { SupabaseClient } from "@supabase/supabase-js";
import { nextJobPoNumber } from "@/lib/job-po-number";
import { siteOneLine, type JobSiteParts } from "@/lib/job-site";
import type { BuilderPoLineInput, CostCentreOption } from "@/lib/builder-po";

// The job's Purchase Orders tab for the office on the PHONE (Nov 2026): the
// builder's POs split by cost centre, the supplier orders under each line and
// their invoices. The web tab (components/job/job-po.tsx) reads and writes
// straight from the browser; the phone has no session cookie and writes
// nothing to Supabase from a screen, so it goes through
// /api/jobs/[id]/purchase-orders/** and .../supplier-orders/[orderId]/**,
// all requireOfficeOrAdmin and run as the CALLER (callerClient) — RLS on
// purchase_orders / po_cost_centers / vendor_orders (office/admin) still
// decides every row. Money is in these answers; only office/admin get them.

export interface PoLineView {
  id: string;
  name: string;
  cost_centre_id: string | null;
  allocated_amount: number;
  allocated_hours: number;
  sort_order: number;
  completed_at: string | null;
}

export interface PoView {
  id: string;
  po_number: string;
  client_reference: string | null;
  site_address: string | null;
  site_lat: number | null;
  site_lng: number | null;
  total_value: number;
  total_hours: number;
  lines: PoLineView[];
}

export interface VendorOrderView {
  id: string;
  cost_center_id: string;
  po_number: string;
  vendor_name: string;
  order_number: string | null;
  description: string | null;
  amount: number;
  gst_amount: number;
  status: "ordered" | "received" | "cancelled";
  order_date: string | null;
  notes: string | null;
  delivered_at: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  invoice_storage_path: string | null;
  xero_bill_id: string | null;
  created_at: string | null;
  raised_by: string | null;
  items: { description: string; quantity: number }[];
}

export interface JobPurchaseOrdersState {
  job: { id: string; jobNumber: number | null; title: string | null };
  /** What a new PO starts with: <job>-n, the client, the job site. */
  defaults: { poNumber: string; clientReference: string; siteAddress: string };
  costCentres: CostCentreOption[];
  pos: PoView[];
  orders: VendorOrderView[];
  /** Hours logged (work, not travel) and expenses per PO line. */
  hoursByLine: Record<string, number>;
  spentByLine: Record<string, number>;
  /** Line id → why it can't be removed (lib/builder-po.ts planBuilderPoEdit). */
  inUse: Record<string, string>;
  /** PO number → the invoice already raised for it on this job. */
  invoicedPos: Record<string, string>;
}

/** The job's site and coordinates, for a new PO's defaults and its pin. */
export interface JobSiteForPo {
  address: string;
  lat: number | null;
  lng: number | null;
}

const num = (v: unknown) => Number(v) || 0;

type JobRow = {
  id: string;
  job_number: number | null;
  title: string | null;
  customers: { name: string | null } | { name: string | null }[] | null;
  sites: (JobSiteParts & { site_lat: number | null; site_lng: number | null }) | (JobSiteParts & { site_lat: number | null; site_lng: number | null })[] | null;
};

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

/** Reads the job's own number, client and site. Null = not on this job / not visible. */
export async function loadJobForPo(supabase: SupabaseClient, jobId: string) {
  const { data, error } = await supabase
    .from("jobs")
    .select("id, job_number, title, customers(name), sites(name, address_line1, suburb, state, postcode, site_lat, site_lng)")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const job = data as unknown as JobRow;
  const site = one(job.sites);
  return {
    id: job.id,
    jobNumber: job.job_number,
    title: job.title,
    customerName: one(job.customers)?.name ?? null,
    site: {
      address: siteOneLine(site),
      lat: site?.site_lat != null ? Number(site.site_lat) : null,
      lng: site?.site_lng != null ? Number(site.site_lng) : null,
    } as JobSiteForPo,
  };
}

/**
 * The pin for a PO's site address. The phone has no geocoder of its own, so
 * a PO keeps its pin while its address is unchanged, takes the job site's pin
 * when the address is the job site's (the web's new-PO default), and has none
 * otherwise — the office can pin it on the web.
 */
export function poSiteCoords(
  address: string,
  jobSite: JobSiteForPo,
  existing?: { site_address: string | null; site_lat: number | null; site_lng: number | null } | null
): { site_lat: number | null; site_lng: number | null } {
  const a = address.trim();
  if (existing && (existing.site_address ?? "").trim() === a) return { site_lat: existing.site_lat, site_lng: existing.site_lng };
  if (a && a === jobSite.address.trim() && jobSite.lat != null && jobSite.lng != null) return { site_lat: jobSite.lat, site_lng: jobSite.lng };
  return { site_lat: null, site_lng: null };
}

/**
 * Why each saved line can't be removed — the web's linesInUse: supplier
 * orders would be deleted with it (0061 cascades); time and expenses would
 * silently lose their cost centre.
 */
export function linesInUse(
  lineIds: string[],
  ordersByLine: Record<string, number>,
  hoursByLine: Record<string, number>,
  spentByLine: Record<string, number>
): Record<string, string> {
  const inUse: Record<string, string> = {};
  for (const id of lineIds) {
    if ((ordersByLine[id] ?? 0) > 0) inUse[id] = "it has supplier orders against it.";
    else if ((hoursByLine[id] ?? 0) > 0) inUse[id] = "time is logged against it.";
    else if ((spentByLine[id] ?? 0) > 0) inUse[id] = "expenses are recorded against it.";
  }
  return inUse;
}

/** Sums work hours and expenses per PO line (travel is not the line's work). */
export function usageByLine(
  timeEntries: { cost_center_id: string | null; hours: number | string | null; entry_type?: string | null }[],
  expenses: { cost_center_id: string | null; amount: number | string | null }[]
): { hoursByLine: Record<string, number>; spentByLine: Record<string, number> } {
  const hoursByLine: Record<string, number> = {};
  const spentByLine: Record<string, number> = {};
  for (const t of timeEntries) {
    if (!t.cost_center_id || t.entry_type === "travel") continue;
    hoursByLine[t.cost_center_id] = (hoursByLine[t.cost_center_id] ?? 0) + num(t.hours);
  }
  for (const e of expenses) {
    if (!e.cost_center_id) continue;
    spentByLine[e.cost_center_id] = (spentByLine[e.cost_center_id] ?? 0) + num(e.amount);
  }
  return { hoursByLine, spentByLine };
}

const PO_SELECT = "id, po_number, client_reference, site_address, site_lat, site_lng, total_value, total_hours, po_cost_centers(id, name, cost_centre_id, allocated_amount, allocated_hours, sort_order, completed_at)";
const PO_SELECT_NO_COMPLETED = "id, po_number, client_reference, site_address, site_lat, site_lng, total_value, total_hours, po_cost_centers(id, name, cost_centre_id, allocated_amount, allocated_hours, sort_order)";
const ORDER_SELECT =
  "id, cost_center_id, po_number, vendor_name, order_number, description, amount, gst_amount, status, order_date, notes, delivered_at, invoice_number, invoice_date, invoice_storage_path, xero_bill_id, created_at, vendor_order_items(description, quantity, sort_order), profiles!vendor_orders_entered_by_fkey(full_name)";

type RawPo = Omit<PoView, "lines"> & { po_cost_centers: Partial<PoLineView>[] | null };
type RawOrder = Omit<VendorOrderView, "items" | "raised_by"> & {
  vendor_order_items: { description: string; quantity: number; sort_order: number }[] | null;
  profiles: { full_name: string | null } | { full_name: string | null }[] | null;
};

function toPoView(p: RawPo): PoView {
  return {
    id: p.id,
    po_number: p.po_number,
    client_reference: p.client_reference,
    site_address: p.site_address,
    site_lat: p.site_lat != null ? Number(p.site_lat) : null,
    site_lng: p.site_lng != null ? Number(p.site_lng) : null,
    total_value: num(p.total_value),
    total_hours: num(p.total_hours),
    lines: [...(p.po_cost_centers ?? [])]
      .map((l) => ({
        id: String(l.id),
        name: String(l.name ?? ""),
        cost_centre_id: l.cost_centre_id ?? null,
        allocated_amount: num(l.allocated_amount),
        allocated_hours: num(l.allocated_hours),
        sort_order: num(l.sort_order),
        completed_at: l.completed_at ?? null,
      }))
      .sort((a, b) => a.sort_order - b.sort_order),
  };
}

function toOrderView(o: RawOrder): VendorOrderView {
  return {
    id: o.id,
    cost_center_id: o.cost_center_id,
    po_number: o.po_number,
    vendor_name: o.vendor_name,
    order_number: o.order_number,
    description: o.description,
    amount: num(o.amount),
    gst_amount: num(o.gst_amount),
    status: o.status,
    order_date: o.order_date,
    notes: o.notes,
    delivered_at: o.delivered_at ?? null,
    invoice_number: o.invoice_number ?? null,
    invoice_date: o.invoice_date ?? null,
    invoice_storage_path: o.invoice_storage_path ?? null,
    xero_bill_id: o.xero_bill_id ?? null,
    created_at: o.created_at ?? null,
    raised_by: one(o.profiles)?.full_name ?? null,
    items: [...(o.vendor_order_items ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((i) => ({ description: i.description, quantity: num(i.quantity) })),
  };
}

/** Reads one PO with its lines, as the caller. */
export async function loadPo(supabase: SupabaseClient, jobId: string, poId: string): Promise<PoView | null> {
  const read = (cols: string) => supabase.from("purchase_orders").select(cols).eq("id", poId).eq("job_id", jobId).maybeSingle();
  let { data, error } = await read(PO_SELECT);
  // completed_at is 0095's; an older database answers 42703.
  if (error?.code === "42703") ({ data, error } = await read(PO_SELECT_NO_COMPLETED));
  if (error) throw error;
  return data ? toPoView(data as unknown as RawPo) : null;
}

/** Everything the phone's PO tab shows. Null = the job isn't there for this caller. */
export async function loadJobPurchaseOrders(supabase: SupabaseClient, jobId: string): Promise<JobPurchaseOrdersState | null> {
  const job = await loadJobForPo(supabase, jobId);
  if (!job) return null;

  const readPos = (cols: string) => supabase.from("purchase_orders").select(cols).eq("job_id", jobId).order("created_at");
  const [posFirst, centresRes, ordersRes, timeRes, expensesRes, invoicesRes] = await Promise.all([
    readPos(PO_SELECT),
    supabase.from("cost_centres").select("id, name").eq("is_active", true).order("sort_order"),
    supabase.from("vendor_orders").select(ORDER_SELECT).eq("job_id", jobId).order("created_at", { ascending: false }),
    supabase.from("time_entries").select("cost_center_id, hours, entry_type").eq("job_id", jobId),
    supabase.from("job_expenses").select("cost_center_id, amount").eq("job_id", jobId),
    supabase.from("invoices").select("invoice_number, customer_po").eq("job_id", jobId).not("customer_po", "is", null),
  ]);
  let posRes = posFirst;
  if (posRes.error?.code === "42703") posRes = await readPos(PO_SELECT_NO_COMPLETED);
  if (posRes.error) throw posRes.error;
  if (ordersRes.error) throw ordersRes.error;
  if (timeRes.error) throw timeRes.error;
  if (expensesRes.error) throw expensesRes.error;
  // The cost centre list and the "already invoiced" hint are helpers: a
  // failed read leaves them empty rather than failing the tab.
  if (centresRes.error) console.error("purchase-orders: cost centres read failed:", centresRes.error);
  if (invoicesRes.error) console.error("purchase-orders: invoices read failed:", invoicesRes.error);

  const pos = ((posRes.data ?? []) as unknown as RawPo[]).map(toPoView);
  const orders = ((ordersRes.data ?? []) as unknown as RawOrder[]).map(toOrderView);
  const { hoursByLine, spentByLine } = usageByLine(
    (timeRes.data ?? []) as { cost_center_id: string | null; hours: number | null; entry_type?: string | null }[],
    (expensesRes.data ?? []) as { cost_center_id: string | null; amount: number | null }[]
  );
  const ordersByLine: Record<string, number> = {};
  for (const o of orders) ordersByLine[o.cost_center_id] = (ordersByLine[o.cost_center_id] ?? 0) + 1;
  const invoicedPos: Record<string, string> = {};
  for (const i of (invoicesRes.data ?? []) as { invoice_number: string | number | null; customer_po: string | null }[]) {
    if (i.customer_po && !invoicedPos[i.customer_po]) invoicedPos[i.customer_po] = String(i.invoice_number ?? "") || "yes";
  }

  return {
    job: { id: job.id, jobNumber: job.jobNumber, title: job.title },
    defaults: {
      poNumber: job.jobNumber != null ? nextJobPoNumber(job.jobNumber, pos.map((p) => p.po_number)) : "",
      clientReference: job.customerName ?? "",
      siteAddress: job.site.address,
    },
    costCentres: ((centresRes.data ?? []) as CostCentreOption[]).map((c) => ({ id: c.id, name: c.name })),
    pos,
    orders,
    hoursByLine,
    spentByLine,
    inUse: linesInUse(pos.flatMap((p) => p.lines.map((l) => l.id)), ordersByLine, hoursByLine, spentByLine),
    invoicedPos,
  };
}

/**
 * A file sent up from the phone as base64 (a supplier invoice, a job
 * document). ≤ 3 MB — it travels inside the request and Vercel caps a request
 * at 4.5 MB. Sniffed, not trusted: JPEG, PNG, WebP or PDF only.
 */
export function decodeUploadedFile(
  v: unknown
): { ok: true; bytes: Uint8Array; contentType: string; ext: string } | { ok: false; error: string } {
  if (typeof v !== "string" || v.length === 0) return { ok: false, error: "Attach the file." };
  const b64 = v.replace(/^data:[a-z]+\/[a-z0-9.+-]+;base64,/i, "");
  if (b64.length > 4_200_000) return { ok: false, error: "That file is too big (3 MB at most). Take the photo again." };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, error: "The file couldn't be read. Try again." };
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (bytes.length < 100) return { ok: false, error: "The file couldn't be read. Try again." };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ok: true, bytes, contentType: "image/jpeg", ext: "jpg" };
  if ([0x89, 0x50, 0x4e, 0x47].every((x, i) => bytes[i] === x)) return { ok: true, bytes, contentType: "image/png", ext: "png" };
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    return { ok: true, bytes, contentType: "image/webp", ext: "webp" };
  }
  if (String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-") return { ok: true, bytes, contentType: "application/pdf", ext: "pdf" };
  return { ok: false, error: "Only photos (JPEG, PNG, WebP) and PDFs can be attached." };
}

/** A file name safe for a storage key, with the extension the bytes really have. */
export function safeFileName(name: unknown, ext: string): string {
  const raw = typeof name === "string" ? name.trim() : "";
  const base = (raw.replace(/\.[A-Za-z0-9]{1,5}$/, "") || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return `${base}.${ext}`;
}

/**
 * Where a supplier invoice file goes: the web's own shape,
 * `{job}/expense-receipt-{PO}-{ts}_{name}`, so 0047's money-file rule hides it
 * from technicians.
 */
export function supplierInvoicePath(jobId: string, poNumber: string, fileName: string, now = Date.now()): string {
  return `${jobId}/expense-receipt-${poNumber.replace(/[^a-zA-Z0-9._-]/g, "_")}-${now}_${fileName}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuidLike = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** A money amount typed on the phone: "1,234.50" → 1234.5; null when not a number ≥ 0. */
export function parseMoney(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null;
  if (typeof v !== "string") return null;
  const t = v.replace(/[$,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

/** The phone's PO form, as sent. Shared by the add and edit routes. */
export function parsePoLines(v: unknown): BuilderPoLineInput[] | null {
  if (!Array.isArray(v) || v.length > 50) return null;
  const out: BuilderPoLineInput[] = [];
  for (const l of v) {
    if (!l || typeof l !== "object") return null;
    const r = l as Record<string, unknown>;
    const str = (x: unknown) => (typeof x === "string" ? x.slice(0, 200) : typeof x === "number" ? String(x) : "");
    out.push({
      id: typeof r.id === "string" && isUuidLike(r.id) ? r.id : undefined,
      costCentreId: typeof r.costCentreId === "string" ? r.costCentreId : "",
      stage: str(r.stage),
      amount: str(r.amount),
      hours: str(r.hours),
    });
  }
  return out;
}
