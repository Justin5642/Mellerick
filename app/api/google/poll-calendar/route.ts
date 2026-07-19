import { NextRequest, NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { pollGoogleCalendarChanges } from "@/lib/google";

// Pulls changes made *directly in Google Calendar* (drag to reschedule,
// resize, or delete an event) back onto the matching job. This is the
// cron-driven half of two-way sync — see vercel.json for the schedule.
// Uses the service-role client because a cron invocation has no browser
// session/cookies to authenticate with. Protected by CRON_SECRET: Vercel
// automatically sends "Authorization: Bearer <CRON_SECRET>" on its own
// cron requests once that env var is set on the project.
export async function GET(request: NextRequest) {
  // Fail CLOSED: if CRON_SECRET isn't configured we must refuse, not run.
  // The old `if (cronSecret)` guard meant a missing/typo'd env var silently
  // skipped auth entirely, leaving this service-role endpoint publicly
  // callable against Google Calendar data.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("CRON_SECRET is not configured — refusing to run poll-calendar");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const result = await pollGoogleCalendarChanges(supabase);
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("Calendar poll-sync error:", err);
    return NextResponse.json({ error: err.message ?? "Calendar poll sync failed" }, { status: 500 });
  }
}
