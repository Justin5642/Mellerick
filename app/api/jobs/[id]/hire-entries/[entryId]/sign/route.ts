import { NextRequest, NextResponse } from "next/server";
import { requireOnJob } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { loadDayWorks } from "@/lib/day-works-load";
import { dayWorksWriteError, decodeSignaturePng, isUuid } from "@/lib/day-works-entry";
import { quantityProblem, type HireUnit } from "@/lib/hire-pricing";

// The builder's rep signs a Day Works entry off on the phone (Stage 2). Same
// steps as the web tab's sign-off: the signature goes to job-documents at
// `<job>/day-works/signature-<entry>-<ts>.png` (no "expense"/"variations"
// segment, so the crew can read it back), then the entry is set signed —
// both with the CALLER's client, so storage policies, RLS and 0108's
// hire_entries_guard decide exactly as they do on the web. Once signed the
// trigger locks it for everyone.
//
// Online only, on purpose: the builder signs on the spot, and an entry that
// only synced later couldn't be shown to them as locked.

type Ctx = { params: Promise<{ id: string; entryId: string }> };

const NOT_FOUND = "That Day Works entry isn't on this job any more. Refresh to see it.";

export async function POST(request: NextRequest, { params }: Ctx) {
  const { id: jobId, entryId } = await params;
  const guard = await requireOnJob(request, jobId);
  if (!guard.ok) return guard.response;
  const isOffice = guard.role === "office" || guard.role === "admin";
  if (!isUuid(entryId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { signer_name?: unknown; signature?: unknown } | null;
  const signerName = typeof body?.signer_name === "string" ? body.signer_name.trim() : "";
  if (!signerName) return NextResponse.json({ error: "Enter the name of the builder's representative." }, { status: 400 });
  if (signerName.length > 120) return NextResponse.json({ error: "Keep the name under 120 characters." }, { status: 400 });
  const signature = decodeSignaturePng(body?.signature);
  if (!signature.ok) return NextResponse.json({ error: signature.error }, { status: 400 });

  try {
    const supabase = await callerClient(request);
    const { data: entry, error: readError } = await supabase
      .from("hire_entries")
      .select("id, job_id, status, signer_name, hire_unit, hours, days, meter_open, meter_close, km")
      .eq("id", entryId)
      .eq("job_id", jobId)
      .maybeSingle();
    if (readError) throw readError;
    if (!entry) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

    if (entry.status !== "draft") {
      // A retry after the answer was lost: the same signer already signed it.
      if (entry.status === "signed" && entry.signer_name === signerName) {
        return NextResponse.json({ ...(await loadDayWorks(request, jobId, { userId: guard.userId, isOffice })), saved: { id: entryId } });
      }
      return NextResponse.json({ error: "This entry was already signed or removed. Refresh to see it." }, { status: 409 });
    }

    const problem = quantityProblem({ ...entry, hire_unit: entry.hire_unit as HireUnit });
    if (problem) return NextResponse.json({ error: `${problem} Edit the entry first.` }, { status: 400 });

    const path = `${jobId}/day-works/signature-${entryId}-${Date.now()}.png`;
    const { error: upErr } = await supabase.storage.from("job-documents").upload(path, signature.bytes, { contentType: "image/png" });
    if (upErr) {
      console.error("day works signature upload error:", upErr);
      reportError(upErr, { route: "api/jobs/hire-entries/sign" });
      return NextResponse.json({ error: "The signature didn't upload. Check the connection and try again." }, { status: 502 });
    }

    const { error, count } = await supabase
      .from("hire_entries")
      .update({ status: "signed", signer_name: signerName, signature_path: path }, { count: "exact" })
      .eq("id", entryId)
      .eq("job_id", jobId)
      .eq("status", "draft");
    if (error || count === 0) {
      // Don't leave a signature behind for an entry that wasn't signed.
      const { error: rmErr } = await supabase.storage.from("job-documents").remove([path]);
      if (rmErr) console.error("day works signature not removed after a refused sign-off:", rmErr);
      if (!error) return NextResponse.json({ error: "This entry was already signed or removed. Refresh to see it." }, { status: 409 });
      const refused = dayWorksWriteError(error);
      if (refused.status === 500) throw error;
      return NextResponse.json({ error: refused.error }, { status: refused.status });
    }

    return NextResponse.json({ ...(await loadDayWorks(request, jobId, { userId: guard.userId, isOffice })), saved: { id: entryId } });
  } catch (err) {
    console.error("day works sign-off error:", err);
    reportError(err, { route: "api/jobs/hire-entries/sign" });
    return NextResponse.json({ error: "Couldn't save the sign-off. Try again." }, { status: 500 });
  }
}
