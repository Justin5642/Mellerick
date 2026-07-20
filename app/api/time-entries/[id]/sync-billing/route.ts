import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api/guards";
import { canManageTimeEntryBilling } from "@/lib/api/job-authz";
import { syncJobBilling } from "@/lib/labour-billing-sync";

// Regenerates a job's auto-generated billing items (the per-entry "Labour"
// line + the one-off "Call Out Fee") after any time entry is written/edited.
// Called fire-and-forget right after a client writes a time entry -- same
// "insert then fetch(/api/...)" pattern used for Google Calendar sync.
//
// Despite being keyed on a single time entry, this reconciles the WHOLE job
// (see lib/labour-billing-sync.ts): recomputing every entry each time makes a
// dropped request self-healing rather than leaving the job permanently
// missing a charge. Uses the service-role key because job_items is Admin-only
// writable (migration 0024) -- so the route authenticates AND authorizes the
// caller (office/admin, or the technician assigned to the entry's job) before
// writing on their behalf.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: timeEntryId } = await params;

  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;

  const admin = createAdminClient();

  const { allowed, jobId } = await canManageTimeEntryBilling(admin, guard.userId, timeEntryId);
  if (!jobId) return NextResponse.json({ error: "Time entry not found" }, { status: 404 });
  if (!allowed) return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });

  const summary = await syncJobBilling(admin, jobId);
  return NextResponse.json({ ok: true, ...summary });
}
