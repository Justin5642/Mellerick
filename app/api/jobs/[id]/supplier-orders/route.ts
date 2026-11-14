import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api/guards";
import { consumeRateLimit, rateLimitedResponse, SUPPLIER_ORDER_LIMIT } from "@/lib/api/rate-limit";
import { businessInfo } from "@/lib/business-info";
import { getResend, getFromAddress } from "@/lib/resend";
import { siteOneLine } from "@/lib/job-site";
import { parseSupplierOrder, supplierOrderEmail } from "@/lib/supplier-orders";
import { reportError } from "@/lib/monitoring";
import { recentSupplierIds, RECENT_SUPPLIER_CANDIDATES } from "@/lib/supplier-picker";

// Supplier POs raised from the phone (migration 0085). Justin, 28 Oct 2026:
// any technician, any job, any supplier, straight to the supplier.
//
// vendor_orders and vendor_order_items are office/admin-only by RLS, and they
// carry money. This route is how a technician reaches them, so it uses the
// service-role client after requireUser — and it NEVER selects amount or
// gst_amount. ORDER_COLS is the whole list of what a technician can learn.
//
// The staff embed names its FK: vendor_orders has two links to profiles
// (entered_by, and delivered_by since 0089), and an unhinted profiles(...)
// makes PostgREST refuse the whole query (PGRST201) — which is how the phone's
// Orders tab showed "Couldn't load purchase orders" after 0089 (2 Nov 2026).
const ORDER_COLS =
  "id, po_number, vendor_name, supplier_email, status, cost_center_id, delivery_address, required_by, notes, created_at, emailed_at, delivered_at";

// A user is waiting on this request while it calls the email provider.
export const maxDuration = 30;

type Admin = ReturnType<typeof createAdminClient>;

async function loadJob(admin: Admin, jobId: string) {
  const { data } = await admin
    .from("jobs")
    .select("id, job_number, scheduled_cost_center_id, sites(name, address_line1, address_line2, suburb, state, postcode)")
    .eq("id", jobId)
    .maybeSingle();
  return data as
    | { id: string; job_number: number | null; scheduled_cost_center_id: string | null; sites: Parameters<typeof siteOneLine>[0] }
    | null;
}

interface OrderRow {
  id: string;
  po_number: string;
  vendor_name: string;
  supplier_email: string | null;
  status: string;
  cost_center_id: string | null;
  delivery_address: string | null;
  required_by: string | null;
  notes: string | null;
  created_at: string;
  emailed_at: string | null;
  delivered_at: string | null;
  profiles: { full_name: string } | null;
  vendor_order_items: { description: string; quantity: number; sort_order: number }[] | null;
}

async function listOrders(admin: Admin, jobId: string) {
  const { data, error } = await admin
    .from("vendor_orders")
    .select(`${ORDER_COLS}, profiles!vendor_orders_entered_by_fkey(full_name), vendor_order_items(description, quantity, sort_order)`)
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  // Docket photos taken against each order (0093). Read on their own and
  // never fatal: a docket count is not worth failing the order list over.
  const dockets = new Map<string, number>();
  const { data: photos, error: photosError } = await admin
    .from("job_photos")
    .select("vendor_order_id")
    .eq("job_id", jobId)
    .not("vendor_order_id", "is", null);
  if (photosError) console.error("supplier orders: docket photos not read:", photosError.message);
  for (const p of (photos ?? []) as { vendor_order_id: string }[]) dockets.set(p.vendor_order_id, (dockets.get(p.vendor_order_id) ?? 0) + 1);
  // Field by field, never a spread: whatever else a row carries stays here.
  return ((data ?? []) as unknown as OrderRow[]).map((o) => ({
    id: o.id,
    poNumber: o.po_number,
    supplierName: o.vendor_name,
    supplierEmail: o.supplier_email,
    status: o.status,
    costCenterId: o.cost_center_id,
    deliveryAddress: o.delivery_address,
    requiredBy: o.required_by,
    notes: o.notes,
    createdAt: o.created_at,
    emailedAt: o.emailed_at,
    deliveredAt: o.delivered_at,
    docketPhotos: dockets.get(o.id) ?? 0,
    raisedBy: o.profiles?.full_name ?? null,
    items: [...(o.vendor_order_items ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((i) => ({ description: i.description, quantity: Number(i.quantity) })),
  }));
}

interface SupplierRow {
  id: string;
  name: string;
  email: string | null;
  default_cost_centre_id: string | null;
  pin_order?: number | null;
}

// The active supplier list, with each one's place in the Pinned group
// (pin_order, from 0097 — drafted, not applied yet).
// A database without pin_order (42703) gets the list unpinned.
async function loadSuppliers(admin: Admin): Promise<SupplierRow[]> {
  const read = (cols: string) => admin.from("suppliers").select(cols).eq("is_active", true).order("name");
  let { data, error } = await read("id, name, email, default_cost_centre_id, pin_order");
  if (error?.code === "42703") ({ data, error } = await read("id, name, email, default_cost_centre_id"));
  if (error) throw error;
  return (data ?? []) as unknown as SupplierRow[];
}

// How many of the newest POs (every job) "recent" is worked out from.
const RECENT_ORDERS_READ = 300;

// The suppliers the caller used most recently on POs, then the company's
// (lib/supplier-picker.ts). Only supplier ids from the list go back — no
// order, job or amount. Never fatal: without it the picker just has no
// Recent group.
async function loadRecentSupplierIds(admin: Admin, userId: string, suppliers: SupplierRow[]): Promise<string[]> {
  const { data, error } = await admin
    .from("vendor_orders")
    .select("supplier_id, vendor_name, entered_by, created_at")
    .order("created_at", { ascending: false })
    .limit(RECENT_ORDERS_READ);
  if (error) {
    console.error("supplier orders: recent suppliers not read:", error.message);
    return [];
  }
  const uses = (
    (data ?? []) as { supplier_id: string | null; vendor_name: string | null; entered_by: string | null; created_at: string | null }[]
  ).map((o) => ({ supplierId: o.supplier_id, vendorName: o.vendor_name, enteredBy: o.entered_by, createdAt: o.created_at }));
  return recentSupplierIds(uses, suppliers, userId, RECENT_SUPPLIER_CANDIDATES);
}

// What the Raise PO form starts with: the orders already on the job, the cost
// centre the tech is clocked into (else the one the job is scheduled to), the
// site address, the supplier list (0087), and which company cost centre each
// of the job's budget lines belongs to — so picking the quarry can put the PO
// on the job's Transport line by itself.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;

  try {
    const admin = createAdminClient();
    const job = await loadJob(admin, id);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const [orders, { data: openEntry }, supplierRows, { data: lines, error: linesError }] = await Promise.all([
      listOrders(admin, id),
      admin
        .from("time_entries")
        .select("cost_center_id")
        .eq("job_id", id)
        .eq("staff_id", guard.userId)
        .is("clock_out", null)
        .neq("entry_type", "travel")
        .order("clock_in", { ascending: false })
        .limit(1)
        .maybeSingle(),
      loadSuppliers(admin),
      admin
        .from("po_cost_centers")
        .select("id, name, cost_centre_id, sort_order, cost_centres(name), purchase_orders!inner(job_id, po_number)")
        .eq("purchase_orders.job_id", id),
    ]);
    if (linesError) throw linesError;

    // Field by field: a supplier's account number and phone stay office-side.
    const suppliers = supplierRows.map((s) => ({
      id: s.id,
      name: s.name,
      email: s.email ?? null,
      defaultCostCentreId: s.default_cost_centre_id ?? null,
      pinOrder: s.pin_order ?? null,
    }));
    const recentIds = await loadRecentSupplierIds(admin, guard.userId, supplierRows);

    return NextResponse.json({
      orders,
      defaultCostCenterId: openEntry?.cost_center_id ?? job.scheduled_cost_center_id ?? null,
      clockedIn: !!openEntry,
      deliveryAddress: siteOneLine(job.sites) || null,
      suppliers,
      // Supplier ids for the picker's Recent group, most recent first: the
      // caller's own POs, then the company's. Older phone builds ignore it.
      recentSupplierIds: recentIds,
      costCentreLines: (lines ?? []).map((l) => ({ id: l.id as string, costCentreId: (l.cost_centre_id as string | null) ?? null })),
      // The job's cost centres, read fresh with every load (2 Nov 2026): the
      // phone's own copy is read once when the job opens, so one added on the
      // web while the job was open never appeared on the Orders tab. Names
      // only — no budgets.
      costCentres: ((lines ?? []) as unknown as {
        id: string;
        name: string;
        sort_order: number | null;
        cost_centres: { name: string } | null;
        purchase_orders: { po_number: string } | null;
      }[])
        .slice()
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((l) => ({ id: l.id, name: l.name, code: null, po_number: l.purchase_orders?.po_number ?? "", costCentre: l.cost_centres?.name ?? null })),
    });
  } catch (err) {
    console.error("supplier orders list error:", err);
    reportError(err, { route: "api/jobs/supplier-orders" });
    return NextResponse.json({ error: "Couldn't load purchase orders. Try again." }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;
  const { id: jobId } = await params;

  const parsed = parseSupplierOrder(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const order = parsed.order;

  try {
    const admin = createAdminClient();
    const job = await loadJob(admin, jobId);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    // A retry of a request whose response never arrived: report the PO it
    // already made, never a second order or a second email.
    const { data: existing } = await admin
      .from("vendor_orders")
      .select("job_id, po_number, supplier_email, emailed_at")
      .eq("id", order.id)
      .maybeSingle();
    if (existing) {
      if (existing.job_id !== jobId) return NextResponse.json({ error: "Order id already used" }, { status: 409 });
      return NextResponse.json({
        poNumber: existing.po_number,
        emailed: !!existing.emailed_at,
        emailedTo: existing.emailed_at ? existing.supplier_email : null,
      });
    }

    if (!(await consumeRateLimit(guard.userId, SUPPLIER_ORDER_LIMIT))) return rateLimitedResponse();

    const { data: cc } = await admin
      .from("po_cost_centers")
      .select("id, purchase_orders!inner(job_id)")
      .eq("id", order.costCenterId)
      .eq("purchase_orders.job_id", jobId)
      .maybeSingle();
    if (!cc) return NextResponse.json({ error: "That cost centre isn't on this job. Pick it again." }, { status: 400 });

    // A supplier picked from the list: its name is the one on file, whatever
    // the phone sent. The email stays as sent — the tech may have cleared it
    // to order at the counter.
    let supplierName = order.supplierName;
    if (order.supplierId) {
      const { data: supplier } = await admin
        .from("suppliers")
        .select("name")
        .eq("id", order.supplierId)
        .eq("is_active", true)
        .maybeSingle();
      if (!supplier) return NextResponse.json({ error: "That supplier isn't on the list any more. Pick it again." }, { status: 400 });
      supplierName = supplier.name as string;
    }

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
    const { data: created, error: insertError } = await admin
      .from("vendor_orders")
      .insert({
        id: order.id,
        job_id: jobId,
        cost_center_id: order.costCenterId,
        supplier_id: order.supplierId,
        vendor_name: supplierName,
        supplier_email: order.supplierEmail,
        delivery_address: order.deliveryAddress,
        required_by: order.requiredBy,
        notes: order.notes,
        description: (order.items.length ? order.items.map((i) => i.description).join(", ") : order.notes ?? "Phone order").slice(0, 300),
        order_date: today,
        status: "ordered",
        entered_by: guard.userId,
      })
      .select("po_number")
      .single();
    if (insertError || !created) throw insertError ?? new Error("vendor order insert returned no row");

    const { error: itemsError } = order.items.length
      ? await admin.from("vendor_order_items").insert(
          order.items.map((i, n) => ({ vendor_order_id: order.id, description: i.description, quantity: i.quantity, sort_order: n }))
        )
      : { error: null };
    if (itemsError) {
      // An order with no lines is useless to the supplier and the office.
      // Remove it so the tech's retry starts clean.
      const { error: undoError } = await admin.from("vendor_orders").delete().eq("id", order.id);
      if (undoError) console.error("supplier order: items failed AND the empty order could not be removed:", undoError.message);
      throw itemsError;
    }

    const poNumber = created.po_number as string;
    if (!order.supplierEmail) return NextResponse.json({ poNumber, emailed: false, emailedTo: null });

    // The PO exists from here on. A failed email is reported, not thrown: the
    // tech still has a PO number to read out over the phone, and the office
    // sees it as "not emailed" on the PO tab.
    try {
      const { data: me } = await admin.from("profiles").select("full_name, phone").eq("id", guard.userId).maybeSingle();
      const email = supplierOrderEmail({
        poNumber,
        jobNumber: job.job_number,
        supplierName,
        raisedBy: me ? { name: me.full_name, phone: me.phone } : null,
        deliveryAddress: order.deliveryAddress,
        requiredBy: order.requiredBy,
        notes: order.notes,
        items: order.items,
        business: businessInfo,
      });
      const { error: sendError } = await getResend().emails.send({
        from: getFromAddress(),
        to: order.supplierEmail,
        cc: businessInfo.email,
        replyTo: businessInfo.email,
        subject: email.subject,
        html: email.html,
      });
      if (sendError) throw new Error(sendError.message);
    } catch (err) {
      console.error("supplier order email failed:", err);
      reportError(err, { route: "api/jobs/supplier-orders", integration: "resend" });
      return NextResponse.json({
        poNumber,
        emailed: false,
        emailedTo: null,
        warning: `${poNumber} is saved on the job, but the email to the supplier didn't send. Phone the order through and quote ${poNumber}.`,
      });
    }

    const { error: stampError } = await admin
      .from("vendor_orders")
      .update({ emailed_at: new Date().toISOString() })
      .eq("id", order.id);
    if (stampError) console.error("supplier order: emailed but emailed_at not stamped:", stampError.message);

    return NextResponse.json({ poNumber, emailed: true, emailedTo: order.supplierEmail });
  } catch (err) {
    console.error("supplier order error:", err);
    reportError(err, { route: "api/jobs/supplier-orders" });
    return NextResponse.json({ error: "Couldn't raise the purchase order. Try again." }, { status: 500 });
  }
}
