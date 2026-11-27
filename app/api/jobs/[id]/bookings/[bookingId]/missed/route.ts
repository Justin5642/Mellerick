import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { isUuid, MISSED_SENTENCES, missedRpcError, parseMissedBody } from "@/lib/booking-missed";

// "Didn't make it" on a booking (Justin, 27 Nov 2026; migration 0121 (draft)). The
// booking's technician (or office/admin) says why they didn't get to it; the
// booking stays where it is, flagged, until the office moves it.
//
//   POST   { reason, note }  → flag_booking_missed()
//   POST   { clear: true }   → clear_booking_missed() (the phone's outbox only POSTs)
//   DELETE                   → clear_booking_missed()
//
// Every read and write runs as the CALLER (callerClient), never the service
// role: job_bookings is office-written by RLS and the database functions are
// the narrow door — they check who, which booking, the job and the day
// themselves. No money: reasons, a note, a time.

type Params = { params: Promise<{ id: string; bookingId: string }> };

const ANSWER_COLUMNS = "id, job_id, staff_id, missed_at, missed_reason, missed_note";

async function run(request: NextRequest, jobId: string, bookingId: string, action: { kind: "flag"; reason: string; note: string | null } | { kind: "clear" }) {
  if (!isUuid(jobId) || !isUuid(bookingId)) {
    return NextResponse.json({ error: MISSED_SENTENCES.badRequest }, { status: 400 });
  }
  try {
    const supabase = await callerClient(request);
    // The booking must be on THIS job (and visible to the caller — RLS 0107).
    const { data: found, error: readError } = await supabase.from("job_bookings").select("id, job_id").eq("id", bookingId).maybeSingle();
    if (readError) {
      console.error("booking-missed read error:", readError.code, readError.message);
      return NextResponse.json({ error: MISSED_SENTENCES.failed }, { status: 500 });
    }
    if (!found || (found as { job_id: string }).job_id !== jobId) {
      return NextResponse.json({ error: MISSED_SENTENCES.notFound }, { status: 404 });
    }

    const { data, error } =
      action.kind === "flag"
        ? await supabase.rpc("flag_booking_missed", { p_booking: bookingId, p_reason: action.reason, p_note: action.note })
        : await supabase.rpc("clear_booking_missed", { p_booking: bookingId });
    if (error) {
      const answer = missedRpcError(error);
      if (answer.status >= 500) {
        console.error("booking-missed rpc error:", error.code, error.message);
        reportError(new Error(`booking missed rpc failed (${error.code ?? "no code"})`), { route: "api/jobs/bookings/missed" });
      }
      return NextResponse.json({ error: answer.error }, { status: answer.status });
    }
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row || typeof row.id !== "string") {
      return NextResponse.json({ error: MISSED_SENTENCES.failed }, { status: 500 });
    }
    const booking: Record<string, unknown> = {};
    for (const k of ANSWER_COLUMNS.split(", ")) booking[k] = row[k] ?? null;
    return NextResponse.json({ booking });
  } catch (err) {
    console.error("booking-missed error:", err);
    reportError(err, { route: "api/jobs/bookings/missed" });
    return NextResponse.json({ error: MISSED_SENTENCES.failed }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const { id: jobId, bookingId } = await params;
  const guard = await requireRole(request, ["admin", "office", "technician"]);
  if (!guard.ok) return guard.response;
  const parsed = parseMissedBody(await request.json().catch(() => null));
  if (parsed.kind === "invalid") return NextResponse.json({ error: parsed.error }, { status: 400 });
  return run(request, jobId, bookingId, parsed);
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id: jobId, bookingId } = await params;
  const guard = await requireRole(request, ["admin", "office", "technician"]);
  if (!guard.ok) return guard.response;
  return run(request, jobId, bookingId, { kind: "clear" });
}
