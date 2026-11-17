import { NextRequest, NextResponse } from "next/server";
import { requireOnJob } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadTruckLoads } from "@/lib/cartage-load";
import { isUuid } from "@/lib/day-works-entry";
import { buildCartageLoadRow, cartageWriteError, parseCartageLoadBody } from "@/lib/cartage-load-entry";

// Edit (PATCH) or delete (DELETE) one truck load that is still a draft (0111).
// The CALLER's client, so RLS (crew of this job, drafts only) and 0111's
// cartage_loads_guard decide; a signed load is locked for everyone. Both
// answer with the fresh section (lib/cartage-load.ts — no money for the crew).

type Ctx = { params: Promise<{ id: string; loadId: string }> };

const LOCKED = "This truck load is signed and locked. Ask the office if it needs changing.";
const NOT_FOUND = "That truck load isn't on this job any more. Refresh to see it.";

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { id: jobId, loadId } = await params;
  const guard = await requireOnJob(request, jobId);
  if (!guard.ok) return guard.response;
  const isOffice = guard.role === "office" || guard.role === "admin";
  if (!isUuid(loadId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const parsed = parseCartageLoadBody(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const built = buildCartageLoadRow(parsed.input);
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });

  try {
    const supabase = await callerClient(request);
    const { data: load, error: readError } = await supabase
      .from("cartage_loads")
      .select("id, job_id, status")
      .eq("id", loadId)
      .eq("job_id", jobId)
      .maybeSingle();
    if (readError) throw readError;
    if (!load) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    if (load.status !== "draft") return NextResponse.json({ error: LOCKED }, { status: 409 });

    const { error, count } = await supabase
      .from("cartage_loads")
      .update(built.row, { count: "exact" })
      .eq("id", loadId)
      .eq("job_id", jobId)
      .eq("status", "draft");
    if (error) {
      const refused = cartageWriteError(error);
      if (refused.status === 500) throw error;
      return NextResponse.json({ error: refused.error }, { status: refused.status });
    }
    if (count === 0) return NextResponse.json({ error: "This load is signed or no longer yours to change. Refresh to see it." }, { status: 409 });

    return NextResponse.json({ ...(await loadTruckLoads(request, jobId, { userId: guard.userId, isOffice })), saved: { id: loadId } });
  } catch (err) {
    console.error("truck load edit error:", err);
    reportError(err, { route: "api/jobs/cartage-loads/load" });
    return NextResponse.json({ error: "Couldn't save the load. Try again." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const { id: jobId, loadId } = await params;
  const guard = await requireOnJob(request, jobId);
  if (!guard.ok) return guard.response;
  const isOffice = guard.role === "office" || guard.role === "admin";
  if (!isUuid(loadId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  try {
    const supabase = await callerClient(request);
    const { data: before, error: readError } = await supabase
      .from("cartage_loads")
      .select("docket_photo_path")
      .eq("id", loadId)
      .eq("job_id", jobId)
      .eq("status", "draft")
      .maybeSingle();
    if (readError) throw readError;
    const { error, count } = await supabase
      .from("cartage_loads")
      .delete({ count: "exact" })
      .eq("id", loadId)
      .eq("job_id", jobId)
      .eq("status", "draft");
    if (error) throw error;
    if (count === 0) {
      return NextResponse.json({ error: "Couldn't delete it — only unsigned loads can be deleted." }, { status: 409 });
    }
    // The docket photo went up through the service role (technicians can't
    // touch money documents), so it is removed the same way once the load is gone.
    const path = (before as { docket_photo_path: string | null } | null)?.docket_photo_path;
    if (path && path.startsWith(`${jobId}/expense-receipt-cartage-${loadId}-`)) {
      const { error: rmErr } = await createAdminClient().storage.from("job-documents").remove([path]);
      if (rmErr) console.error("truck load docket photo not removed:", rmErr);
    }
    return NextResponse.json(await loadTruckLoads(request, jobId, { userId: guard.userId, isOffice }));
  } catch (err) {
    console.error("truck load delete error:", err);
    reportError(err, { route: "api/jobs/cartage-loads/load" });
    return NextResponse.json({ error: "Couldn't delete the load. Try again." }, { status: 500 });
  }
}
