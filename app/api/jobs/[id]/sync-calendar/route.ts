import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getGoogleCalendarClient } from "@/lib/google";
import { requireUser } from "@/lib/api/guards";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Any authenticated staff member can trigger a calendar sync for a job they
  // can see; the route previously had no auth check at all.
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const supabase = await createClient();

  try {
    const calendar = await getGoogleCalendarClient();
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
        await supabase.from("jobs").update({ google_event_id: null }).eq("id", id);
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
    await supabase.from("jobs").update({ google_event_id: res.data.id }).eq("id", id);
    return NextResponse.json({ created: true, eventId: res.data.id });
  } catch (err: any) {
    console.error("Calendar sync error:", err);
    return NextResponse.json({ error: err.message ?? "Calendar sync failed" }, { status: 500 });
  }
}
