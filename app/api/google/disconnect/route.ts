import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api/guards";

export async function POST(request: NextRequest) {
  // Disconnecting Google Calendar wipes the org-wide token — admin-only
  // (previously any unauthenticated POST relied solely on RLS to no-op).
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  // Token tables are service-role only once migration 0075 (a draft, not
  // applied yet) is in; the guard above has already authorised the caller.
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("google_tokens")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");

  // Redirecting to `?google=disconnected` regardless of what happened is the
  // worst possible answer here: the settings page then says Calendar is
  // disconnected while the refresh token is still in the database and the cron
  // poll keeps using it. Deliberately NOT checking `count` — disconnecting when
  // nothing is connected is a no-op, not a failure.
  if (error) {
    return NextResponse.redirect(
      new URL(`/dashboard/settings?google=error&reason=${encodeURIComponent(error.message)}`, request.url)
    );
  }
  return NextResponse.redirect(new URL("/dashboard/settings?google=disconnected", request.url));
}
