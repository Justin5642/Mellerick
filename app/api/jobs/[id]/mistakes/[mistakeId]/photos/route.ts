import { NextRequest, NextResponse } from "next/server";
import { requireOnJob } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { isUuid } from "@/lib/day-works-entry";
import { decodeDocketImage } from "@/lib/cartage-load-entry";
import { MISTAKE_SENTENCES, mistakePhotoPath, mistakeRpcError } from "@/lib/mistake-raise";

// A photo of a mistake (0119, a draft not applied yet), after the mistake is logged — from the phone's
// camera or library, or the web's file picker (resized first). Whoever logged
// it, or the office.
//   1. requireOnJob (office, or on this job's crew);
//   2. the bytes are checked (JPEG/PNG/WebP, ≤ 3 MB);
//   3. uploaded to job-photos at <job>/mistakes/<mistake>/<ts>.<ext> with the
//      CALLER's client (job-photos takes uploads from anyone signed in, 0049);
//   4. filed by add_job_mistake_photo() as the CALLER, which checks the caller
//      raised the mistake (or is office/admin) and that the path is this
//      mistake's. If it refuses, the file is removed again.
// No money in the answer: the photo count only.

type Ctx = { params: Promise<{ id: string; mistakeId: string }> };

export const maxDuration = 30;

export async function POST(request: NextRequest, { params }: Ctx) {
  const { id: jobId, mistakeId } = await params;
  const guard = await requireOnJob(request, jobId);
  if (!guard.ok) return guard.response;
  if (!isUuid(mistakeId)) return NextResponse.json({ error: MISTAKE_SENTENCES.photoNotFound }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { image?: unknown } | null;
  const image = decodeDocketImage(body?.image);
  if (!image.ok) return NextResponse.json({ error: "The photo couldn't be read — it must be a JPEG, PNG or WebP picture under 3 MB." }, { status: 400 });

  try {
    const supabase = await callerClient(request);
    const path = mistakePhotoPath(jobId, mistakeId, image.ext, Date.now());
    const { error: upErr } = await supabase.storage.from("job-photos").upload(path, image.bytes, { contentType: image.contentType });
    if (upErr) {
      console.error("mistake photo upload error:", upErr.message);
      return NextResponse.json({ error: MISTAKE_SENTENCES.photoFailed }, { status: 502 });
    }
    const { error } = await supabase.rpc("add_job_mistake_photo", { p_mistake_id: mistakeId, p_path: path });
    if (error) {
      const { error: rmErr } = await supabase.storage.from("job-photos").remove([path]);
      if (rmErr) console.error("mistake photo not removed after a refusal:", rmErr.message);
      const answer = mistakeRpcError(error);
      if (answer.status >= 500) {
        console.error("add_job_mistake_photo error:", error.code, error.message);
        reportError(new Error(`add_job_mistake_photo failed (${error.code ?? "no code"})`), { route: "api/jobs/mistakes/photos" });
      }
      return NextResponse.json({ error: answer.error }, { status: answer.status });
    }
    return NextResponse.json({ saved: true });
  } catch (err) {
    console.error("mistake photo error:", err);
    reportError(err, { route: "api/jobs/mistakes/photos" });
    return NextResponse.json({ error: MISTAKE_SENTENCES.photoFailed }, { status: 500 });
  }
}
