import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getGoogleCalendarClient } from "@/lib/google";
import { requireUser } from "@/lib/api/guards";
import { canManageJobBilling } from "@/lib/api/job-authz";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Any authenticated staff member can trigger a calendar sync for a job they
  // can see; the route previously had no auth check at all.
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;

  const { id } = await params;

  // Q1: this used the COOKIE-scoped client, so a mobile Bearer caller (which
  // sends no cookies) executed every query as `anon`. google_tokens is
  // office/admin-only since migration 0027, so the token read returned nothing
  // and the route answered HTTP 200 {skipped:true} — which the mobile outbox
  // treats as success, silently marking the op done and NEVER syncing the
  // calendar. A web technician hit the same dead end. Use the service-role
  // client (same pattern as the other Bearer-replayed side-effect routes) and
  // authorize the record explicitly, since service-role bypasses RLS.
  const supabase = createAdminClient();
  if (!(await canManageJobBilling(supabase, guard.userId, id))) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  try {
    const calendar = await getGoogleCalendarClient(supabase);
    if (!calendar) {
      return NextResponse.json({ skipped: true, reason: "Google Calendar not connected" });
    }

    const { data: job } = await supabase
      .from("jobs")
      .select("*, customers(name), sites(address_line1, suburb, state, postcode)")
      .eq("id", id)
      .single();

    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const shouldRemove = !job.scheduled_start || job.status === "cancelled" || job.status === "completed";

    if (shouldRemove) {
      if (job.google_event_id) {
        try {
          await calendar.events.delete({ calendarId: "primary", eventId: job.google_event_id });
        } catch (e: any) {
          if (e?.code !== 404 && e?.code !== 410) throw e;
        }
        // The event is gone from Google. If clearing the id fails, the job
        // still points at an event that no longer exists, and the next sync
        // takes the UPDATE branch, gets a 404, and falls through to recreate —
        // so the failure is self-correcting rather than duplicating. Worth
        // saying, not worth failing the request over.
        const { error: clearError } = await supabase.from("jobs").update({ google_event_id: null }).eq("id", id);
        if (clearError) {
          console.error("Calendar sync: event deleted but job still references it:", clearError.message);
          return NextResponse.json({ removed: true, linkCleared: false, warning: clearError.message });
        }
      }
      return NextResponse.json({ removed: true });
    }

    const site = job.sites as any;
    const location = site
      ? [site.address_line1, site.suburb, site.state, site.postcode].filter(Boolean).join(", ")
      : undefined;
    const start = new Date(job.scheduled_start);
    const end = job.scheduled_end ? new Date(job.scheduled_end) : new Date(start.getTime() + 60 * 60 * 1000);

    const eventBody = {
      summary: `#${job.job_number} — ${job.title}`,
      description: [job.description, (job.customers as any)?.name ? `Customer: ${(job.customers as any).name}` : null]
        .filter(Boolean)
        .join("\n\n"),
      location,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    };

    if (job.google_event_id) {
      try {
        const res = await calendar.events.update({
          calendarId: "primary",
          eventId: job.google_event_id,
          requestBody: eventBody,
        });
        return NextResponse.json({ updated: true, eventId: res.data.id });
      } catch (e: any) {
        if (e?.code !== 404 && e?.code !== 410) throw e;
        // Event was deleted on Google's side — fall through and recreate it.
      }
    }

    const res = await calendar.events.insert({ calendarId: "primary", requestBody: eventBody });

    // Recording the event id is the ONLY thing that stops the next sync taking
    // this same create branch — `if (job.google_event_id)` above is the whole
    // dedupe. The result used to be discarded, so a failed write meant a SECOND
    // calendar event for the same job, and a first event the app could never
    // update or delete because it no longer knew its id.
    //
    // Same shape, and same remedy, as the Xero link writes in push-invoice and
    // push-expense: retry, then refuse in terms that stop a human retrying
    // blind, because by now the event EXISTS in Google.
    let linkError: { message: string } | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await supabase.from("jobs").update({ google_event_id: res.data.id }).eq("id", id);
      linkError = error;
      if (!error) break;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 150 * attempt));
    }

    if (linkError) {
      console.error("Calendar link write failed after 3 attempts:", linkError.message);
      return NextResponse.json(
        {
          error:
            `The calendar event WAS created (${res.data.id}) but could not be linked to this job ` +
            `(${linkError.message}). DO NOT RETRY — syncing again would create a duplicate event. ` +
            `Delete the event in Google Calendar, or set this job's google_event_id manually.`,
          eventId: res.data.id,
          requiresManualReconciliation: true,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ created: true, eventId: res.data.id });
  } catch (err: any) {
    console.error("Calendar sync error:", err);
    return NextResponse.json({ error: err.message ?? "Calendar sync failed" }, { status: 500 });
  }
}
