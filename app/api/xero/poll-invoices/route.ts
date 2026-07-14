import { NextRequest, NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { pollXeroInvoicePayments } from "@/lib/xero";

// Cron-triggered reverse sync: pulls invoice payment status back from Xero
// so invoices paid outside the app (bank feed reconciliation, manual entry
// in Xero, etc) get marked paid here too. Mirrors /api/google/poll-calendar.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const result = await pollXeroInvoicePayments(supabase);
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("Xero invoice poll-sync error:", err);
    return NextResponse.json({ error: err.message ?? "Xero invoice sync failed" }, { status: 500 });
  }
}
