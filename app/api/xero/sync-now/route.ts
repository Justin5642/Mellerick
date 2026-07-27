import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { pollXeroInvoicePayments } from "@/lib/xero";

// Manual trigger for the Settings page's "Sync now" button — same logic as the
// cron poll route. Previously auth'd by getUser() ONLY (any signed-in user,
// including a technician, could trigger a Xero payments sync); now office/admin
// -only via the shared guard, and Bearer-aware (mobile) via callerClient.
export async function POST(request: NextRequest) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const supabase = await callerClient(request);

  try {
    const result = await pollXeroInvoicePayments(supabase);
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("Xero invoice manual sync error:", err);
    return NextResponse.json({ error: err.message ?? "Xero invoice sync failed" }, { status: 500 });
  }
}
