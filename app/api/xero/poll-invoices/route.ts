import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireCronSecret } from "@/lib/api/guards";
import { pollXeroInvoicePayments } from "@/lib/xero";

// Cron-triggered reverse sync: pulls invoice payment status back from Xero
// so invoices paid outside the app (bank feed reconciliation, manual entry
// in Xero, etc) get marked paid here too. Mirrors /api/google/poll-calendar.
export async function GET(request: NextRequest) {
  // Cron-secret gate, fails CLOSED on a missing secret (see requireCronSecret).
  const guard = requireCronSecret(request);
  if (!guard.ok) return guard.response;

  const supabase = createAdminClient();

  try {
    const result = await pollXeroInvoicePayments(supabase);
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("Xero invoice poll-sync error:", err);
    return NextResponse.json({ error: err.message ?? "Xero invoice sync failed" }, { status: 500 });
  }
}
