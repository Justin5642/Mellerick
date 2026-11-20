import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, requireCronSecret } from "@/lib/api/guards";
import { KomtraxHttpError, KomtraxTablesMissing, syncKomtrax } from "@/lib/komtrax";
import { reportError } from "@/lib/monitoring";

export const maxDuration = 60;

// Reads Komatsu Komtrax (ISO 15143-3) into the 0113 tables: each machine's
// hours, position, fuel and fault codes. Read-only toward Komatsu. Komatsu
// refuses a URL asked twice in 15 minutes, so a run straight after another
// is answered {skipped:true} without calling them.

async function run(route: string) {
  try {
    const result = await syncKomtrax(createAdminClient());
    return NextResponse.json(result);
  } catch (err: unknown) {
    if (err instanceof KomtraxTablesMissing) {
      return NextResponse.json({ skipped: true, reason: "Komtrax tables not found" });
    }
    console.error("Komtrax sync error:", err instanceof Error ? err.message : "unknown");
    reportError(err, { route, integration: "komtrax", ...(err instanceof KomtraxHttpError ? { status: err.status } : {}) });
    return NextResponse.json({ error: "Komtrax sync failed" }, { status: 500 });
  }
}

// Cron, every 6 hours.
export async function GET(request: NextRequest) {
  const guard = requireCronSecret(request);
  if (!guard.ok) return guard.response;
  return run("api/komtrax/sync");
}

// Manual run (admin): Fleet → Komtrax machines → Sync Komtrax.
export async function POST(request: NextRequest) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  return run("api/komtrax/sync");
}
