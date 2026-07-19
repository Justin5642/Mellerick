import { NextRequest, NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { pollXeroInvoicePayments } from "@/lib/xero";

// Cron-triggered reverse sync: pulls invoice payment status back from Xero
// so invoices paid outside the app (bank feed reconciliation, manual entry
// in Xero, etc) get marked paid here too. Mirrors /api/google/poll-calendar.
export async function GET(request: NextRequest) {
  // Fail CLOSED: if CRON_SECRET isn't configured we must refuse, not run.
  // The old `if (cronSecret)` guard meant a missing/typo'd env var silently
  // skipped auth entirely, leaving this service-role endpoint publicly
  // callable against Xero invoice data.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("CRON_SECRET is not configured — refusing to run poll-invoices");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
