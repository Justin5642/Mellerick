import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";

// Remove a payment recorded against an invoice (migration 0081). Office/admin,
// as the caller under RLS; 0081's trigger then puts amount_paid and the
// status back (a paid invoice returns to sent, or overdue past its due date).
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; paymentId: string }> }) {
  const { id, paymentId } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const supabase = await callerClient(request);

  const { error, count } = await supabase
    .from("invoice_payments")
    .delete({ count: "exact" })
    .eq("id", paymentId)
    .eq("invoice_id", id);
  if (error || count === 0) {
    if (error) console.error("invoice payments: delete failed", error);
    return NextResponse.json({ error: "That payment could not be removed." }, { status: error ? 500 : 404 });
  }
  return NextResponse.json({ ok: true });
}
