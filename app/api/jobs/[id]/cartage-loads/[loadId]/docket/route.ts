import { NextRequest, NextResponse } from "next/server";
import { requireOnJob } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/monitoring";
import { loadTruckLoads } from "@/lib/cartage-load";
import { isUuid } from "@/lib/day-works-entry";
import { decodeDocketImage, docketPhotoPath } from "@/lib/cartage-load-entry";

// Attach the docket photo to a truck load (0111). A quarry or tip docket shows
// prices, so the photo is a MONEY DOCUMENT: it is stored in job-documents at
// <job>/expense-receipt-cartage-<load>-<ts>.<ext>, which 0047/0065's
// storage_object_is_money_document() hides from technicians — who therefore
// can't upload it themselves. So, in this order:
//   1. requireOnJob (the caller is office or on this job's crew);
//   2. the load is read with the CALLER's client (RLS: theirs to see) and must
//      still be a draft (the office may attach one to a signed load too);
//   3. the bytes are checked (JPEG/PNG/WebP, ≤ 3 MB) and uploaded with the
//      service role to that path, under this job and load only;
//   4. the path is set on the load — with the service role, because 0111's
//      guard keeps docket_photo_path out of the crew's own writes (so a
//      technician can't point a load at some other file). Scoped by id + job
//      + the status read in step 2, after steps 1–2 proved the caller may
//      change this load. Nothing else is written.
// The crew never get the photo back: their answer says only that one is attached.

type Ctx = { params: Promise<{ id: string; loadId: string }> };

const NOT_FOUND = "That truck load isn't on this job any more. Refresh to see it.";

export const maxDuration = 30;

export async function POST(request: NextRequest, { params }: Ctx) {
  const { id: jobId, loadId } = await params;
  const guard = await requireOnJob(request, jobId);
  if (!guard.ok) return guard.response;
  const isOffice = guard.role === "office" || guard.role === "admin";
  if (!isUuid(loadId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { image?: unknown } | null;
  const image = decodeDocketImage(body?.image);
  if (!image.ok) return NextResponse.json({ error: image.error }, { status: 400 });

  try {
    const supabase = await callerClient(request);
    const { data: load, error: readError } = await supabase
      .from("cartage_loads")
      .select("id, job_id, status, docket_photo_path")
      .eq("id", loadId)
      .eq("job_id", jobId)
      .maybeSingle();
    if (readError) throw readError;
    if (!load) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    const allowed = load.status === "draft" || (isOffice && load.status !== "void");
    if (!allowed) return NextResponse.json({ error: "This truck load is signed and locked. Ask the office to attach the docket." }, { status: 409 });

    const admin = createAdminClient();
    const path = docketPhotoPath(jobId, loadId, image.ext);
    const { error: upErr } = await admin.storage.from("job-documents").upload(path, image.bytes, { contentType: image.contentType });
    if (upErr) {
      console.error("truck load docket upload error:", upErr);
      reportError(upErr, { route: "api/jobs/cartage-loads/docket" });
      return NextResponse.json({ error: "The photo didn't upload. Check the connection and try again." }, { status: 502 });
    }

    const { data: updated, error } = await admin
      .from("cartage_loads")
      .update({ docket_photo_path: path })
      .eq("id", loadId)
      .eq("job_id", jobId)
      .eq("status", load.status as string)
      .select("id");
    if (error || (updated ?? []).length === 0) {
      const { error: rmErr } = await admin.storage.from("job-documents").remove([path]);
      if (rmErr) console.error("truck load docket photo not removed after a refused update:", rmErr);
      if (error) throw error;
      return NextResponse.json({ error: "This load changed while the photo was uploading. Refresh and try again." }, { status: 409 });
    }
    // The photo it replaces, if any (same job and load only).
    const old = load.docket_photo_path as string | null;
    if (old && old !== path && old.startsWith(`${jobId}/expense-receipt-cartage-${loadId}-`)) {
      const { error: rmErr } = await admin.storage.from("job-documents").remove([old]);
      if (rmErr) console.error("old truck load docket photo not removed:", rmErr);
    }

    return NextResponse.json({ ...(await loadTruckLoads(request, jobId, { userId: guard.userId, isOffice })), saved: { id: loadId } });
  } catch (err) {
    console.error("truck load docket error:", err);
    reportError(err, { route: "api/jobs/cartage-loads/docket" });
    return NextResponse.json({ error: "Couldn't attach the docket. Try again." }, { status: 500 });
  }
}
