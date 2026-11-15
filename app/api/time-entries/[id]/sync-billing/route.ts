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

  // Automatic labour lines are off (0086), so there is nothing to sync —
  // answer done before looking for the entry. The phone queues this after
  // every clock write, including a clock-on the one-open-entry rule (0090)
  // refused as a duplicate: that row never exists, a 404 reads as "not there
  // yet", and the phone retried it forever ("Syncing" that never cleared,
  // 2 Nov 2026).
  const { data: config } = await admin.from("billing_rate_config").select("auto_labour_lines").eq("id", true).maybeSingle();
  if (config?.auto_labour_lines === false) return NextResponse.json({ ok: true, disabled: true });

  const { allowed, jobId } = await canManageTimeEntryBilling(admin, guard.userId, timeEntryId);
  if (!jobId) return NextResponse.json({ error: "Time entry not found" }, { status: 404 });
  if (!allowed) return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });

  const summary = await syncJobBilling(admin, jobId);
  return NextResponse.json({ ok: true, ...summary });
}
