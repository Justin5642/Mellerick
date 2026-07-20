import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/api/guards";

export async function POST(request: NextRequest) {
  // Disconnecting Google Calendar wipes the org-wide token — admin-only
  // (previously any unauthenticated POST relied solely on RLS to no-op).
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const supabase = await createClient();
  await supabase.from("google_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  return NextResponse.redirect(new URL("/dashboard/settings?google=disconnected", request.url));
}
