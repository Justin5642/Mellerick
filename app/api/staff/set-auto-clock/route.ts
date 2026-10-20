import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api/guards";

// Turn someone's auto clock-in on or off (profiles.auto_clock, 0082). Admin
// only, like role and active status: it decides how a person's hours are
// recorded. The database enforces the same rule (prevent_unauthorised_role_change).
export async function POST(request: NextRequest) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  let body: { id?: unknown; enabled?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { id, enabled } = body;
  if (typeof id !== "string" || typeof enabled !== "boolean") {
    return NextResponse.json({ error: "id and enabled are required" }, { status: 400 });
  }

  const { error, count } = await createAdminClient()
    .from("profiles")
    .update({ auto_clock: enabled }, { count: "exact" })
    .eq("id", id);
  if (error || count === 0) {
    console.error("staff/set-auto-clock: update failed", error);
    return NextResponse.json({ error: "Could not update this staff member" }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
