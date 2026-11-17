import { NextRequest, NextResponse } from "next/server";
import { requireOnJob } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { loadTruckLoads } from "@/lib/cartage-load";
import { decodeSignaturePng, isUuid } from "@/lib/day-works-entry";
import { cartageWriteError, loadSignProblem } from "@/lib/cartage-load-entry";

// The builder's rep signs off the day's truck loads on the phone (0111, drafted — not applied yet): one
// name and one signature for several loads at once. The signature goes to
// job-documents at `<job>/day-works/signature-loads-<ts>.png` (no "expense"
// segment, so the crew can read it back, as for Day Works), then every load is
// set signed in ONE update — with the CALLER's client, so storage policies,
// RLS and 0111's cartage_loads_guard decide, and either all of them sign or
// none do. Once signed the trigger locks them for everyone.

const MAX_LOADS = 50;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;
  const guard = await requireOnJob(request, jobId);
  if (!guard.ok) return guard.response;
  const isOffice = guard.role === "office" || guard.role === "admin";

  const body = (await request.json().catch(() => null)) as { load_ids?: unknown; signer_name?: unknown; signature?: unknown } | null;
  const ids = Array.isArray(body?.load_ids) ? [...new Set(body.load_ids)] : [];
  if (ids.length === 0 || !ids.every(isUuid)) return NextResponse.json({ error: "Pick the loads to sign." }, { status: 400 });
  if (ids.length > MAX_LOADS) return NextResponse.json({ error: `Sign at most ${MAX_LOADS} loads at a time.` }, { status: 400 });
  const loadIds = ids as string[];
  const signerName = typeof body?.signer_name === "string" ? body.signer_name.trim() : "";
  if (!signerName) return NextResponse.json({ error: "Enter the name of the builder's representative." }, { status: 400 });
  if (signerName.length > 120) return NextResponse.json({ error: "Keep the name under 120 characters." }, { status: 400 });
  const signature = decodeSignaturePng(body?.signature);
  if (!signature.ok) return NextResponse.json({ error: signature.error }, { status: 400 });

  try {
    const supabase = await callerClient(request);
    const { data: rows, error: readError } = await supabase
      .from("cartage_loads")
      .select("id, status, signer_name, quantity")
      .eq("job_id", jobId)
      .in("id", loadIds);
    if (readError) throw readError;
    const loads = (rows ?? []) as { id: string; status: string; signer_name: string | null; quantity: number | string | null }[];
    if (loads.length !== loadIds.length) {
      return NextResponse.json({ error: "Some of those loads aren't on this job any more. Refresh to see them." }, { status: 404 });
    }

    if (loads.every((l) => l.status !== "draft")) {
      // A retry after the answer was lost: the same signer already signed them all.
      if (loads.every((l) => l.status === "signed" && l.signer_name === signerName)) {
        return NextResponse.json({ ...(await loadTruckLoads(request, jobId, { userId: guard.userId, isOffice })), signed: loadIds });
      }
    }
    if (loads.some((l) => l.status !== "draft")) {
      return NextResponse.json({ error: "Some of those loads were already signed or removed. Refresh to see them." }, { status: 409 });
    }
    const unready = loads.find((l) => loadSignProblem(l));
    if (unready) return NextResponse.json({ error: "Enter how much was carted on every load before it's signed. Edit the load first." }, { status: 400 });

    const path = `${jobId}/day-works/signature-loads-${Date.now()}.png`;
    const { error: upErr } = await supabase.storage.from("job-documents").upload(path, signature.bytes, { contentType: "image/png" });
    if (upErr) {
      console.error("truck loads signature upload error:", upErr);
      reportError(upErr, { route: "api/jobs/cartage-loads/sign" });
      return NextResponse.json({ error: "The signature didn't upload. Check the connection and try again." }, { status: 502 });
    }

    const { error, count } = await supabase
      .from("cartage_loads")
      .update({ status: "signed", signer_name: signerName, signature_path: path }, { count: "exact" })
      .eq("job_id", jobId)
      .in("id", loadIds)
      .eq("status", "draft");
    if (error || count !== loadIds.length) {
      // Don't leave a signature behind for loads that weren't signed (but keep
      // it if a race let some of them sign — they point at it).
      if (!error && (count ?? 0) > 0) {
        return NextResponse.json({ error: "Some of those loads were already signed or removed. Refresh to see them." }, { status: 409 });
      }
      const { error: rmErr } = await supabase.storage.from("job-documents").remove([path]);
      if (rmErr) console.error("truck loads signature not removed after a refused sign-off:", rmErr);
      if (!error) return NextResponse.json({ error: "Some of those loads were already signed or removed. Refresh to see them." }, { status: 409 });
      const refused = cartageWriteError(error);
      if (refused.status === 500) throw error;
      return NextResponse.json({ error: refused.error }, { status: refused.status });
    }

    return NextResponse.json({ ...(await loadTruckLoads(request, jobId, { userId: guard.userId, isOffice })), signed: loadIds });
  } catch (err) {
    console.error("truck loads sign-off error:", err);
    reportError(err, { route: "api/jobs/cartage-loads/sign" });
    return NextResponse.json({ error: "Couldn't save the sign-off. Try again." }, { status: 500 });
  }
}
