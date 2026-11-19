import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { APPROVAL_HOURS_MAX_JOBS, approvalHoursByJob, parseApprovalJobIds } from "@/lib/invoice-hours";

// The clocked hours each pending job will carry onto its invoice, for the
// phone's Approvals screen (the web page reads the same thing on the server:
// lib/invoice-hours.ts approvalHoursByJob). Hours only — no rates, no money.
//
// Office/admin, read as the CALLER under RLS (never the service role).
// GET /api/approvals/hours?jobIds=<uuid>,<uuid>,…
export async function GET(request: NextRequest) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;

  const jobIds = parseApprovalJobIds(request.nextUrl.searchParams.get("jobIds"));
  if (!jobIds) {
    return NextResponse.json({ error: `Give between 1 and ${APPROVAL_HOURS_MAX_JOBS} job ids.` }, { status: 400 });
  }
  const hoursByJob = await approvalHoursByJob(await callerClient(request), jobIds);
  return NextResponse.json({ hoursByJob });
}
