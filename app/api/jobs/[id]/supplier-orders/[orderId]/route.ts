import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { isUuidLike, loadJobPurchaseOrders, parseMoney } from "@/lib/job-purchase-orders";

// The office's edits to one supplier order from the phone's PO tab (Nov 2026)
// — the web PO tab's amount box, status drop-down and bin. Office/admin only
// and run as the caller: vendor_orders is office/admin by RLS (0061). The
// amount (ex GST) locks once the order's invoice is a Xero bill, as on the
// web. Each answer is the fresh tab.

type Ctx = { params: Promise<{ id: string; orderId: string }> };

const NOT_FOUND = "That supplier order isn't on this job any more. Refresh to see it.";
const STATUSES = new Set(["ordered", "received", "cancelled"]);

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { id: jobId, orderId } = await params;
  if (!isUuidLike(jobId) || !isUuidLike(orderId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const patch: { amount?: number; status?: string } = {};
  if (body && "amount" in body) {
    const amount = parseMoney(body.amount ?? "0");
    if (amount === null) return NextResponse.json({ error: "Check the amount (ex GST)." }, { status: 400 });
    patch.amount = amount;
  }
  if (body && "status" in body) {
    if (typeof body.status !== "string" || !STATUSES.has(body.status)) return NextResponse.json({ error: "Pick a status." }, { status: 400 });
    patch.status = body.status;
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

  try {
    const supabase = await callerClient(request);
    const { data: order, error: readError } = await supabase
      .from("vendor_orders")
      .select("id, xero_bill_id")
      .eq("id", orderId)
      .eq("job_id", jobId)
      .maybeSingle();
    if (readError) throw readError;
    if (!order) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    if (patch.amount !== undefined && order.xero_bill_id) {
      return NextResponse.json({ error: "Already sent to Xero as a bill — change the amount in Xero." }, { status: 409 });
    }
    const { error, count } = await supabase.from("vendor_orders").update(patch, { count: "exact" }).eq("id", orderId).eq("job_id", jobId);
    if (error) throw error;
    if (count === 0) return NextResponse.json({ error: "Couldn't update the order." }, { status: 409 });
    return NextResponse.json(await loadJobPurchaseOrders(supabase, jobId));
  } catch (err) {
    console.error("supplier order PATCH error:", err);
    reportError(err, { route: "api/jobs/supplier-orders/[orderId]" });
    return NextResponse.json({ error: "Couldn't update the order. Try again." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { id: jobId, orderId } = await params;
  if (!isUuidLike(jobId) || !isUuidLike(orderId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  try {
    const supabase = await callerClient(request);
    const { error, count } = await supabase.from("vendor_orders").delete({ count: "exact" }).eq("id", orderId).eq("job_id", jobId);
    if (error) throw error;
    const state = await loadJobPurchaseOrders(supabase, jobId);
    if (!state) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    if (count === 0 && state.orders.some((o) => o.id === orderId)) {
      return NextResponse.json({ error: "Couldn't remove this supplier order." }, { status: 409 });
    }
    return NextResponse.json(state);
  } catch (err) {
    console.error("supplier order DELETE error:", err);
    reportError(err, { route: "api/jobs/supplier-orders/[orderId]" });
    return NextResponse.json({ error: "Couldn't remove the order. Try again." }, { status: 500 });
  }
}
