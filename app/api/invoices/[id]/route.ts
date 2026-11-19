import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";

// Delete an invoice — office/admin, as it always was on the web (it used to be
// a browser delete); the phone uses the same route.
//
// The delete cascades to invoice_items; job variations billed on it go back
// to un-invoiced (0011: on delete set null); recorded payments go with it
// (0081). An invoice already pushed to Xero is NOT removed from Xero — the
// confirm says so, and the answer repeats it (`inXero`) so the caller can
// remind them to void it there.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const supabase = await callerClient(request);

  const { data: invoice } = await supabase.from("invoices").select("id, xero_invoice_id").eq("id", id).maybeSingle();
  if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

  const { error, count } = await supabase.from("invoices").delete({ count: "exact" }).eq("id", id);
  if (error || count === 0) {
    if (error) console.error("invoice delete failed", error);
    return NextResponse.json({ error: "The invoice could not be deleted. Please try again." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, inXero: !!invoice.xero_invoice_id });
}
