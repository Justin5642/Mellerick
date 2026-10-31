import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireCronSecret } from "@/lib/api/guards";
import { syncXeroSuppliers } from "@/lib/xero-suppliers";
import { reportError } from "@/lib/monitoring";

export const maxDuration = 60;

// Nightly copy of Xero's suppliers into the app's supplier list, so a supplier
// account opened in Xero shows up in the crew's drop-down the next morning.
export async function GET(request: NextRequest) {
  const guard = requireCronSecret(request);
  if (!guard.ok) return guard.response;

  try {
    const result = await syncXeroSuppliers(createAdminClient());
    return NextResponse.json(result);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "Xero not connected") {
      return NextResponse.json({ skipped: true, reason: "Xero not connected" });
    }
    console.error("Xero supplier poll error:", err);
    reportError(err, { route: "api/xero/poll-suppliers", integration: "xero", cron: true });
    return NextResponse.json({ error: "Xero supplier sync failed" }, { status: 500 });
  }
}
