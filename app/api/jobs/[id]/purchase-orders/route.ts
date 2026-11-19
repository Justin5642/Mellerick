import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { planBuilderPo } from "@/lib/builder-po";
import { isUuidLike, loadJobForPo, loadJobPurchaseOrders, parsePoLines, poSiteCoords } from "@/lib/job-purchase-orders";

// The job's builder POs for the office on the phone (Nov 2026). GET = the
// whole PO tab (POs, lines, supplier orders, what's logged against each line);
// POST = add a PO, the web's planBuilderPo rules. Office/admin only, and every
// read and write runs as the caller (callerClient) so RLS on purchase_orders /
// po_cost_centers / vendor_orders still decides. Money is in these answers —
// they never reach a technician (requireOfficeOrAdmin, then RLS).

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = "That job isn't there any more.";

export async function GET(request: NextRequest, { params }: Ctx) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { id: jobId } = await params;
  if (!isUuidLike(jobId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  try {
    const supabase = await callerClient(request);
    const state = await loadJobPurchaseOrders(supabase, jobId);
    if (!state) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    return NextResponse.json(state);
  } catch (err) {
    console.error("purchase-orders GET error:", err);
    reportError(err, { route: "api/jobs/purchase-orders" });
    return NextResponse.json({ error: "Couldn't load the purchase orders. Try again." }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { id: jobId } = await params;
  if (!isUuidLike(jobId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const poId = body?.id;
  const poNumber = typeof body?.poNumber === "string" ? body.poNumber.trim().slice(0, 100) : "";
  const lines = parsePoLines(body?.lines ?? []);
  if (!isUuidLike(poId)) return NextResponse.json({ error: "The form is out of date. Close it and try again." }, { status: 400 });
  if (!poNumber) return NextResponse.json({ error: "Enter the PO number." }, { status: 400 });
  if (!lines) return NextResponse.json({ error: "Check the cost centre lines." }, { status: 400 });
  const value = typeof body?.value === "string" ? body.value : typeof body?.value === "number" ? String(body.value) : "";
  const clientReference = typeof body?.clientReference === "string" ? body.clientReference.trim().slice(0, 200) : "";
  const siteAddress = typeof body?.siteAddress === "string" ? body.siteAddress.trim().slice(0, 300) : "";

  try {
    const supabase = await callerClient(request);
    const job = await loadJobForPo(supabase, jobId);
    if (!job) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

    // A retry after a dropped answer: the PO is already there. Answer as saved.
    const { data: existing, error: existingError } = await supabase.from("purchase_orders").select("id").eq("id", poId).maybeSingle();
    if (existingError) throw existingError;
    if (existing) return NextResponse.json(await loadJobPurchaseOrders(supabase, jobId));

    const { data: centres } = await supabase.from("cost_centres").select("id, name").eq("is_active", true);
    const planned = planBuilderPo({ value, lines }, (centres ?? []) as { id: string; name: string }[]);
    if (!planned.ok) return NextResponse.json({ error: planned.error }, { status: 400 });

    const { error: poError } = await supabase.from("purchase_orders").insert({
      id: poId,
      job_id: jobId,
      po_number: poNumber,
      client_reference: clientReference || null,
      site_address: siteAddress || null,
      ...poSiteCoords(siteAddress, job.site),
      total_value: planned.po.value,
      total_hours: planned.po.totalHours,
    });
    if (poError) throw poError;

    let warning: string | undefined;
    if (planned.po.lines.length > 0) {
      const { error: linesError } = await supabase.from("po_cost_centers").insert(planned.po.lines.map((l) => ({ ...l, po_id: poId })));
      // The PO itself is real, so say so rather than pretending nothing was written.
      if (linesError) {
        console.error("purchase-orders POST: po_cost_centers insert failed:", linesError);
        warning = "Purchase order saved, but its cost centres didn't. Use Edit on the PO to add them.";
      }
    }
    if (!warning && planned.po.unallocated > 0) warning = "Purchase order saved — part of its value isn't split yet.";
    const state = await loadJobPurchaseOrders(supabase, jobId);
    return NextResponse.json({ ...state, warning });
  } catch (err) {
    console.error("purchase-orders POST error:", err);
    reportError(err, { route: "api/jobs/purchase-orders" });
    return NextResponse.json({ error: "Couldn't save the purchase order. Try again." }, { status: 500 });
  }
}
