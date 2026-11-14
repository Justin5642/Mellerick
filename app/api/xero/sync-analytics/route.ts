import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, requireCronSecret } from "@/lib/api/guards";
import { AnalyticsTablesMissing, syncXeroAnalytics } from "@/lib/xero-analytics";
import { reportError } from "@/lib/monitoring";

export const maxDuration = 60;

// Mirrors Xero's invoices, bills, payments and monthly P&L into our own tables
// (draft migration 0098 — not applied until Justin applies it) for business analysis. Read-only toward Xero. Resumable: a
// run that runs out of time or hits Xero's rate limit continues next time, so
// the first runs after connecting are the 24-month backfill.

async function run(route: string) {
  try {
    const result = await syncXeroAnalytics(createAdminClient());
    return NextResponse.json(result);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "Xero not connected") {
      return NextResponse.json({ skipped: true, reason: "Xero not connected" });
    }
    if (err instanceof AnalyticsTablesMissing) {
      return NextResponse.json({ skipped: true, reason: "Xero analytics tables not found" });
    }
    console.error("Xero analytics sync error:", err);
    reportError(err, { route, integration: "xero" });
    return NextResponse.json({ error: "Xero analytics sync failed" }, { status: 500 });
  }
}

// Nightly cron.
export async function GET(request: NextRequest) {
  const guard = requireCronSecret(request);
  if (!guard.ok) return guard.response;
  return run("api/xero/sync-analytics");
}

// Manual run (admin) — e.g. straight after reconnecting Xero with the new scopes.
export async function POST(request: NextRequest) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  return run("api/xero/sync-analytics");
}
