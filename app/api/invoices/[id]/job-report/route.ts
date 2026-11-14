import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { buildJobReportDraft, loadJobReportContext } from "@/lib/job-report-data";
import { reportError } from "@/lib/monitoring";

// The Send Invoice dialog's "Include job report and photos" draft: the default
// work-done notes, the days attended (names only, no hours), the job's
// eligible photos with thumbnail URLs, and the customer sign-off if there is
// one. Office/admin only — same guard and caller-scoped client as the send
// route. Nothing returned carries money (lib/job-report.ts).

export const maxDuration = 30;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  try {
    const { id } = await params;
    const supabase = await callerClient(request);
    const loaded = await loadJobReportContext(supabase, id);
    if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
    const draft = await buildJobReportDraft(supabase, loaded.context);
    return NextResponse.json(draft);
  } catch (err) {
    console.error("job report draft error:", err);
    reportError(err, { route: "api/invoices/job-report", operation: "draft" });
    return NextResponse.json({ error: "Could not load the job report. Try again." }, { status: 500 });
  }
}
