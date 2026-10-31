import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncXeroSuppliers } from "@/lib/xero-suppliers";
import { reportError } from "@/lib/monitoring";

// A user is waiting on this request while it pages through Xero's contacts.
export const maxDuration = 30;

// The Suppliers page's "Copy from Xero" button. Office/admin only; the same
// copy runs nightly from /api/xero/poll-suppliers.
export async function POST(request: NextRequest) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;

  try {
    const result = await syncXeroSuppliers(createAdminClient());
    return NextResponse.json(result);
  } catch (err: unknown) {
    console.error("Xero supplier sync error:", err);
    reportError(err, { route: "api/xero/sync-suppliers", integration: "xero" });
    const notConnected = err instanceof Error && err.message === "Xero not connected";
    return NextResponse.json(
      { error: notConnected ? "Xero isn't connected. Connect it in Settings first." : "Couldn't copy suppliers from Xero. Try again." },
      { status: notConnected ? 409 : 500 }
    );
  }
}
