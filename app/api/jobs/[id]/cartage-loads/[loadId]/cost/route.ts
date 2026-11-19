import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { loadTruckLoads } from "@/lib/cartage-load";
import { isUuid } from "@/lib/day-works-entry";
import { parseLoadCostBody } from "@/lib/day-works-office";

// A truck load's docket cost (ex GST) and margin override (office/admin; web
// Day Works tab and the phone). cartage_load_costs is office/admin only by RLS
// and 0111 locks it once the load is invoiced or void; this writes with the
// CALLER's client so both apply. Answers with the fresh section, priced.

type Ctx = { params: Promise<{ id: string; loadId: string }> };

const NOT_FOUND = "That truck load isn't on this job any more. Refresh to see it.";
const LOCKED = "Couldn't save the docket cost. It's locked once the load is invoiced.";

export async function PUT(request: NextRequest, { params }: Ctx) {
  const { id: jobId, loadId } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  if (!isUuid(jobId) || !isUuid(loadId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const parsed = parseLoadCostBody(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const supabase = await callerClient(request);
    // The load must be on THIS job (the cost row only names the load).
    const { data: load, error: readError } = await supabase.from("cartage_loads").select("id, status").eq("id", loadId).eq("job_id", jobId).maybeSingle();
    if (readError) throw readError;
    if (!load) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    if (load.status === "invoiced" || load.status === "void") return NextResponse.json({ error: LOCKED }, { status: 409 });

    const { error } = await supabase
      .from("cartage_load_costs")
      .upsert({ load_id: loadId, docket_cost_ex_gst: parsed.docketCost, margin_pct: parsed.marginPct }, { onConflict: "load_id" });
    if (error) {
      if (error.code === "23514" || error.code === "42501") return NextResponse.json({ error: LOCKED }, { status: 409 });
      throw error;
    }

    return NextResponse.json(await loadTruckLoads(request, jobId, { userId: guard.userId, isOffice: true }));
  } catch (err) {
    console.error("truck load cost error:", err);
    reportError(err, { route: "api/jobs/cartage-loads/cost" });
    return NextResponse.json({ error: "Couldn't save the docket cost. Try again." }, { status: 500 });
  }
}
