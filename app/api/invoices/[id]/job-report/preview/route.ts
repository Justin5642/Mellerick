import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { buildJobReportPdf, loadJobReportContext } from "@/lib/job-report-data";
import { parseJobReportRequest } from "@/lib/job-report";
import { reportError } from "@/lib/monitoring";

// "Preview report" in the Send Invoice dialog: renders exactly what the send
// route would attach, from { notes, photoIds, includeSignature }, and returns
// the PDF. Photo ids are checked against the invoice's job server-side.
// A note about photos left out (size cap, unreadable) rides in X-Report-Notice.

// Downloads and downscales up to 40 photos before rendering.
export const maxDuration = 60;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  try {
    const { id } = await params;
    const body = await request.json().catch(() => null);
    const parsed = parseJobReportRequest(body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const supabase = await callerClient(request);
    const loaded = await loadJobReportContext(supabase, id);
    if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: loaded.status });

    const report = await buildJobReportPdf(supabase, loaded.context, parsed.value);
    const headers: Record<string, string> = {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="job-report-${loaded.context.invoice.invoice_number}.pdf"`,
      "Cache-Control": "no-store",
    };
    // Header values must be plain ASCII.
    if (report.notice) headers["X-Report-Notice"] = encodeURIComponent(report.notice);
    return new NextResponse(new Uint8Array(report.buffer), { headers });
  } catch (err) {
    console.error("job report preview error:", err);
    reportError(err, { route: "api/invoices/job-report/preview", integration: "react-pdf" });
    return NextResponse.json({ error: "The job report could not be made. Try again." }, { status: 500 });
  }
}
