import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { pollXeroInvoicePayments } from "@/lib/xero";

// Manual trigger for the Settings page's "Sync now" button — same logic as
// the cron poll route, but authenticated by the user's normal logged-in
// session instead of CRON_SECRET, since only signed-in app users can reach it.
export async function POST() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const result = await pollXeroInvoicePayments(supabase);
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("Xero invoice manual sync error:", err);
    return NextResponse.json({ error: err.message ?? "Xero invoice sync failed" }, { status: 500 });
  }
}
