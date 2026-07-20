import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireCronSecret } from "@/lib/api/guards";
import { pollGoogleCalendarChanges } from "@/lib/google";

// Pulls changes made *directly in Google Calendar* (drag to reschedule,
// resize, or delete an event) back onto the matching job. This is the
// cron-driven half of two-way sync — see vercel.json for the schedule.
// Uses the service-role client because a cron invocation has no browser
// session/cookies to authenticate with. Protected by CRON_SECRET (fails
// closed if unset — see requireCronSecret).
export async function GET(request: NextRequest) {
  const guard = requireCronSecret(request);
  if (!guard.ok) return guard.response;

  const supabase = createAdminClient();

  try {
    const result = await pollGoogleCalendarChanges(supabase);
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("Calendar poll-sync error:", err);
    return NextResponse.json({ error: err.message ?? "Calendar poll sync failed" }, { status: 500 });
  }
}
