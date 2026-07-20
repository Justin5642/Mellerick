import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api/guards";
import { canManageJobBilling } from "@/lib/api/job-authz";
import { syncJobBilling } from "@/lib/labour-billing-sync";

// Job-level reconcile of the auto-generated billing items (Labour per work
// entry + one Call Out Fee) -- see lib/labour-billing-sync.ts. Used to
// self-heal a job whose per-entry sync was dropped (e.g. viewing Line Items,
// or opening the invoice builder for the job) so what you bill from is always
// current.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;

  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;

  const admin = createAdminClient();

  // Authorize before the service-role write: office/admin, or the technician
  // assigned to this job (so the mobile self-heal after logging their own time
  // keeps working). A tech cannot reconcile billing on someone else's job.
  if (!(await canManageJobBilling(admin, guard.userId, jobId))) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const summary = await syncJobBilling(admin, jobId);
  return NextResponse.json({ ok: true, ...summary });
}
