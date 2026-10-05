import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOfficeOrAdmin } from "@/lib/api/guards";

// Bearer-replayed side-effect for mobile's outbox, mirroring sync-calendar:
// the mobile ScheduleRepository has no native RPC-calling path, so it enqueues
// this route as a "assign-technicians" SideEffectOperation instead of calling
// set_job_assignments directly. Service-role client + explicit guard, same
// reasoning as sync-calendar and sync-billing — a mobile Bearer caller sends no
// cookies, so a cookie-scoped client would run every query as anon.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const staffIds = body?.staffIds;
  if (!Array.isArray(staffIds) || !staffIds.every((s) => typeof s === "string")) {
    return NextResponse.json({ error: "staffIds must be a string array" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("set_job_assignments", {
    p_job_id: id,
    p_staff_ids: staffIds,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Same silent-RLS-drop check as setJobAssignments in lib/schedule-dispatch.ts —
  // the admin client bypasses RLS so a mismatch here would mean a bad staff id,
  // not a permission issue, but the shape of the check still catches it.
  const got = new Set((data ?? []).map((r: { staff_id: string }) => r.staff_id));
  const want = new Set(staffIds);
  const matches = got.size === want.size && [...want].every((sid) => got.has(sid));
  if (!matches) {
    return NextResponse.json({ error: "Technician assignment could not be saved" }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
}
