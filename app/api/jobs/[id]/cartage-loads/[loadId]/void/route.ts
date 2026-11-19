import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { loadTruckLoads } from "@/lib/cartage-load";
import { isUuid } from "@/lib/day-works-entry";
import { parseVoidBody } from "@/lib/day-works-office";

// Void a SIGNED truck load (office/admin; web Day Works tab and the phone).
// The CALLER's client, so RLS and 0111's cartage_loads_guard decide (only the
// office may void; void is final; an invoiced load must come off its invoice
// first). Answers with the fresh section (lib/cartage-load.ts, office view).

type Ctx = { params: Promise<{ id: string; loadId: string }> };

const NOT_FOUND = "That truck load isn't on this job any more. Refresh to see it.";

export async function POST(request: NextRequest, { params }: Ctx) {
  const { id: jobId, loadId } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  if (!isUuid(jobId) || !isUuid(loadId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const parsed = parseVoidBody(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const supabase = await callerClient(request);
    const { data: load, error: readError } = await supabase.from("cartage_loads").select("id, status").eq("id", loadId).eq("job_id", jobId).maybeSingle();
    if (readError) throw readError;
    if (!load) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    if (load.status === "invoiced") return NextResponse.json({ error: "Take this load off its invoice before voiding it." }, { status: 409 });
    if (load.status !== "signed") return NextResponse.json({ error: "Only a signed load can be voided. Delete a draft instead." }, { status: 409 });

    const { error, count } = await supabase
      .from("cartage_loads")
      .update({ status: "void", void_reason: parsed.reason }, { count: "exact" })
      .eq("id", loadId)
      .eq("job_id", jobId)
      .eq("status", "signed");
    if (error) throw error;
    if (count === 0) return NextResponse.json({ error: "Couldn't void it — it changed meanwhile. Refresh to see it." }, { status: 409 });

    return NextResponse.json(await loadTruckLoads(request, jobId, { userId: guard.userId, isOffice: true }));
  } catch (err) {
    console.error("truck load void error:", err);
    reportError(err, { route: "api/jobs/cartage-loads/void" });
    return NextResponse.json({ error: "Couldn't void the load. Try again." }, { status: 500 });
  }
}
