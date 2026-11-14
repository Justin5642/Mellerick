import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOfficeOrAdmin } from "@/lib/api/job-authz";
import { attachEffectiveRates } from "@/lib/fleet-rates";

// Active equipment with the rate job costing should use attached
// (lib/fleet-costs.ts). For the screens that load equipment in the browser:
// the job's Equipment/Costing tabs and the staff cost dialog.
//
// The actual rate is built from every expense, every usage entry and the
// assigned drivers' hours, which RLS rightly hides from technicians — so it is
// computed with the service role, and only for office/admin. Technicians get
// the same rows without it (their screens do not show costs; they fall back
// to the estimate exactly as before).
//
//   ?assigned_to=<staff id>  only equipment assigned to that person
export async function GET(request: NextRequest) {
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;

  const assignedTo = request.nextUrl.searchParams.get("assigned_to");
  const db = await callerClient(request);
  let q = db.from("equipment").select("*").eq("is_active", true).order("name");
  if (assignedTo) q = q.eq("assigned_to", assignedTo);
  const { data, error } = await q;
  if (error) {
    console.error("fleet rates: equipment read failed", error);
    return NextResponse.json({ error: "Could not load equipment" }, { status: 500 });
  }

  const admin = createAdminClient();
  if (!(await isOfficeOrAdmin(admin, guard.userId))) {
    return NextResponse.json({ equipment: data ?? [] });
  }
  return NextResponse.json({ equipment: await attachEffectiveRates(admin, (data ?? []) as any[]) });
}
