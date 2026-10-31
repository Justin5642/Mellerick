import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api/guards";
import { reportError } from "@/lib/monitoring";

// The crew taps Delivered on a supplier PO when the materials arrive on site
// (Stage 4, 31 Oct 2026: "Yes, tap only"). vendor_orders is office/admin-only
// by RLS, so like raising the order this goes through the service-role client
// after requireUser — and writes only the delivery, never a price.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; orderId: string }> }) {
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;
  const { id: jobId, orderId } = await params;

  try {
    const admin = createAdminClient();
    const { data: order } = await admin
      .from("vendor_orders")
      .select("id, job_id, status, delivered_at")
      .eq("id", orderId)
      .maybeSingle();
    if (!order || order.job_id !== jobId) return NextResponse.json({ error: "Order not found on this job" }, { status: 404 });
    if (order.status === "cancelled") return NextResponse.json({ error: "That PO was cancelled" }, { status: 400 });
    // Tapped twice: the first delivery stands.
    if (order.delivered_at) return NextResponse.json({ deliveredAt: order.delivered_at });

    const deliveredAt = new Date().toISOString();
    const { error } = await admin
      .from("vendor_orders")
      .update({ status: "received", delivered_at: deliveredAt, delivered_by: guard.userId })
      .eq("id", orderId);
    if (error) throw error;
    return NextResponse.json({ deliveredAt });
  } catch (err) {
    console.error("supplier order delivered error:", err);
    reportError(err, { route: "api/jobs/supplier-orders/delivered" });
    return NextResponse.json({ error: "Couldn't mark it delivered. Try again." }, { status: 500 });
  }
}
