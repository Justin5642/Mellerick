import { NextRequest, NextResponse } from "next/server";
import { requireOnJob } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { loadTruckLoads } from "@/lib/cartage-load";
import { buildCartageLoadRow, cartageWriteError, parseCartageLoadBody } from "@/lib/cartage-load-entry";

// Truck loads (0111, drafted — not applied yet): the "Truck loads" section of the job's Day Works tab.
// The driver logs each trip as it happens — quarry product in, spoil out to a
// tip — with the docket number and photo; extras are signed off by the
// builder's rep (sign/), then locked and invoiced with Day Works.
//
// The reads (and the money rule) are in lib/cartage-load.ts: names and
// quantities for the crew; docket costs, rates and prices only for
// office/admin. Every write uses the CALLER's client, so RLS (crew of this
// job) and 0111's cartage_loads_guard decide — never the service role for a
// write to the load itself. Every write answers with the fresh section.
//
// Online only, like Day Works and supplier POs: the builder signs on the spot.

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;
  const guard = await requireOnJob(request, jobId);
  if (!guard.ok) return guard.response;
  const isOffice = guard.role === "office" || guard.role === "admin";

  try {
    return NextResponse.json(await loadTruckLoads(request, jobId, { userId: guard.userId, isOffice }));
  } catch (err) {
    console.error("truck loads list error:", err);
    reportError(err, { route: "api/jobs/cartage-loads" });
    return NextResponse.json({ error: "Couldn't load the truck loads. Try again." }, { status: 500 });
  }
}

/**
 * Log a load (the phone). Safe to retry with the same `id`: a load already
 * saved under it on this job is answered as saved, not added twice.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;
  const guard = await requireOnJob(request, jobId);
  if (!guard.ok) return guard.response;
  const isOffice = guard.role === "office" || guard.role === "admin";

  const parsed = parseCartageLoadBody(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const built = buildCartageLoadRow(parsed.input);
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });

  try {
    const supabase = await callerClient(request);
    const loadId = parsed.id ?? crypto.randomUUID();

    const { data: existing, error: existingError } = await supabase.from("cartage_loads").select("id, job_id").eq("id", loadId).maybeSingle();
    if (existingError) throw existingError;
    if (existing && existing.job_id !== jobId) {
      return NextResponse.json({ error: "That load belongs to another job." }, { status: 409 });
    }
    if (!existing) {
      const { error } = await supabase.from("cartage_loads").insert({ id: loadId, job_id: jobId, ...built.row });
      if (error) {
        const refused = cartageWriteError(error);
        if (refused.status === 500) throw error;
        return NextResponse.json({ error: refused.error }, { status: refused.status });
      }
    }

    const view = await loadTruckLoads(request, jobId, { userId: guard.userId, isOffice });
    return NextResponse.json({ ...view, saved: { id: loadId } }, { status: existing ? 200 : 201 });
  } catch (err) {
    console.error("truck load add error:", err);
    reportError(err, { route: "api/jobs/cartage-loads" });
    return NextResponse.json({ error: "Couldn't save the load. Try again." }, { status: 500 });
  }
}
