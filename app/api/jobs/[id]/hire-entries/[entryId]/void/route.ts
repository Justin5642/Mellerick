import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { loadDayWorks } from "@/lib/day-works-load";
import { isUuid } from "@/lib/day-works-entry";
import { parseVoidBody } from "@/lib/day-works-office";

// Void a SIGNED Day Works line (office/admin; web tab and the phone). The
// CALLER's client, so RLS and 0108's hire_entries_guard decide (only the
// office may void; void is final; an invoiced line must come off its invoice
// first). Answers with the fresh tab (lib/day-works-load.ts, office view).

type Ctx = { params: Promise<{ id: string; entryId: string }> };

const NOT_FOUND = "That Day Works entry isn't on this job any more. Refresh to see it.";

export async function POST(request: NextRequest, { params }: Ctx) {
  const { id: jobId, entryId } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  if (!isUuid(jobId) || !isUuid(entryId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const parsed = parseVoidBody(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const supabase = await callerClient(request);
    const { data: entry, error: readError } = await supabase.from("hire_entries").select("id, status").eq("id", entryId).eq("job_id", jobId).maybeSingle();
    if (readError) throw readError;
    if (!entry) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    if (entry.status === "invoiced") return NextResponse.json({ error: "Take this entry off its invoice before voiding it." }, { status: 409 });
    if (entry.status !== "signed") return NextResponse.json({ error: "Only a signed entry can be voided. Delete a draft instead." }, { status: 409 });

    const { error, count } = await supabase
      .from("hire_entries")
      .update({ status: "void", void_reason: parsed.reason }, { count: "exact" })
      .eq("id", entryId)
      .eq("job_id", jobId)
      .eq("status", "signed");
    if (error) throw error;
    if (count === 0) return NextResponse.json({ error: "Couldn't void it — it changed meanwhile. Refresh to see it." }, { status: 409 });

    return NextResponse.json(await loadDayWorks(request, jobId, { userId: guard.userId, isOffice: true }));
  } catch (err) {
    console.error("day works void error:", err);
    reportError(err, { route: "api/jobs/hire-entries/void" });
    return NextResponse.json({ error: "Couldn't void the entry. Try again." }, { status: 500 });
  }
}
