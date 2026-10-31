import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api/guards";
import { reportError } from "@/lib/monitoring";

// "Set site location here" (clock extras, 31 Oct 2026): standing on site, a
// crew member drops the job site's pin where they are, so the auto-clock fence
// is right — for sites with no pin (lot and new-estate addresses the geocoder
// can't place) or a wrong one. Sites are written by the office normally, so
// this goes through the service role after checking the caller is on the job,
// and records who moved the pin and when (migration 0092, DRAFT, not applied yet).

/** A pin worse than this would make the fence worse, not better. */
const MAX_PIN_ACCURACY_METRES = 50;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;
  const { id: jobId } = await params;
  const b = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const lat = Number(b.lat);
  const lng = Number(b.lng);
  const accuracy = b.accuracy == null ? null : Number(b.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
    return NextResponse.json({ error: "Couldn't read your location. Try again." }, { status: 400 });
  }
  if (accuracy === null || !Number.isFinite(accuracy) || accuracy > MAX_PIN_ACCURACY_METRES) {
    return NextResponse.json(
      { error: `Your phone's location isn't accurate enough${accuracy ? ` (±${Math.round(accuracy)} m)` : ""}. Step into the open and try again.` },
      { status: 400 }
    );
  }

  try {
    const admin = createAdminClient();
    const { data: job } = await admin.from("jobs").select("id, site_id, assigned_to").eq("id", jobId).maybeSingle();
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    if (!job.site_id) return NextResponse.json({ error: "This job has no site to pin. Ask the office to add one." }, { status: 400 });

    const isOffice = guard.role === "office" || guard.role === "admin";
    if (!isOffice && job.assigned_to !== guard.userId) {
      const { data: crew } = await admin
        .from("job_assignments")
        .select("job_id")
        .eq("job_id", jobId)
        .eq("staff_id", guard.userId)
        .maybeSingle();
      if (!crew) return NextResponse.json({ error: "Only the crew on this job can set its site location." }, { status: 403 });
    }

    const { error } = await admin
      .from("sites")
      .update({ site_lat: lat, site_lng: lng, location_set_by: guard.userId, location_set_at: new Date().toISOString() })
      .eq("id", job.site_id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("set site location error:", err);
    reportError(err, { route: "api/jobs/site-location" });
    return NextResponse.json({ error: "Couldn't save the site location. Try again." }, { status: 500 });
  }
}
