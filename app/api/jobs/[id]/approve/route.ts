import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { approveJob } from "@/lib/approve-job";

// Approve a completed job and build its draft invoice — see lib/approve-job.ts.
// Admin-only, as the Approve button always was: approving can lead to a Xero
// push, and Justin's rule is that only an admin's approval ever does that.
// Runs as the caller (not the service role) so RLS applies as it did in the
// browser.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const body = await request.json().catch(() => ({}));
  const notes = typeof body?.notes === "string" ? body.notes.slice(0, 4000) : null;

  const db = await callerClient(request);
  const result = await approveJob(db, { jobId, approverId: guard.userId, notes });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result);
}
