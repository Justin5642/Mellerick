import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/monitoring";
import { listJobStages } from "@/lib/builder-po-stages";
import { openStartStages, type StartStage } from "@/lib/self-start-booking";
import { closedJobSentence, parseSelfStartBody, selfStartRpcError, SELF_START_SENTENCES } from "@/lib/self-start";

// "Start work on this job" (Justin, 25 Nov 2026): a technician who pops into
// a job they're not booked on picks the stage they're working on and clocks
// on; the booking appears on the schedule from that moment ("Added by
// technician") and ends when they clock off (migration 0118).
//
//   GET  — the job's stages, for the picker: ids, names, the company cost
//          centre's name and whether each is complete. NEVER an amount.
//   POST — { bookingId, costCenterId, entryId } → the caller's booking, made
//          by self_start_job_booking() run as the CALLER (callerClient, so
//          auth.uid() is them). The phone then clocks on through its outbox
//          with entryId and the same cost centre.
//
// Reads, and why each client:
//   • jobs (status, number, title) and the caller's profile — SERVICE ROLE,
//     after requireRole: a technician who isn't on the job may still look it
//     up (Search), and the profile's limited_access flag (0110) isn't in the
//     guard's answer.
//   • po_cost_centers — SERVICE ROLE through listJobStages(), which selects
//     names and completion only (it is office-only by RLS: it carries money).
// The write is never the service role: job_bookings is office-written by RLS,
// and the database function is the one narrow door for a technician — it
// re-checks the job, the stage and the caller itself.

const CLOSED = new Set(["completed", "cancelled"]);

type JobRow = { id: string; job_number: number | null; title: string | null; status: string };

async function loadJob(jobId: string): Promise<JobRow | null> {
  const { data } = await createAdminClient().from("jobs").select("id, job_number, title, status").eq("id", jobId).maybeSingle();
  return (data as JobRow | null) ?? null;
}

async function isLimitedAccount(userId: string): Promise<boolean> {
  const { data } = await createAdminClient().from("profiles").select("*").eq("id", userId).maybeSingle();
  return (data as { limited_access?: boolean | null } | null)?.limited_access === true;
}

async function loadStages(jobId: string): Promise<StartStage[]> {
  const stages = await listJobStages(createAdminClient(), jobId);
  return stages.map((s) => ({ id: s.id, name: s.name, costCentre: s.costCentre, completedAt: s.completedAt }));
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;
  const guard = await requireRole(request, ["technician", "office", "admin"]);
  if (!guard.ok) return guard.response;
  if (guard.role === "technician" && (await isLimitedAccount(guard.userId))) {
    return NextResponse.json({ error: SELF_START_SENTENCES.notTechnician }, { status: 403 });
  }

  try {
    const job = await loadJob(jobId);
    if (!job) return NextResponse.json({ error: SELF_START_SENTENCES.notFound }, { status: 404 });
    const stages = await loadStages(jobId);
    return NextResponse.json({
      job: { id: job.id, jobNumber: job.job_number, title: job.title, status: job.status, closed: CLOSED.has(job.status) },
      stages,
      openCount: openStartStages(stages).length,
    });
  } catch (err) {
    console.error("self-start stages error:", err);
    reportError(err, { route: "api/jobs/self-start" });
    return NextResponse.json({ error: SELF_START_SENTENCES.loadFailed }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;
  const guard = await requireRole(request, ["technician"]);
  if (!guard.ok) return guard.response;

  const body = parseSelfStartBody(await request.json().catch(() => null));
  if (!body) return NextResponse.json({ error: SELF_START_SENTENCES.badRequest }, { status: 400 });

  try {
    if (await isLimitedAccount(guard.userId)) {
      return NextResponse.json({ error: SELF_START_SENTENCES.notTechnician }, { status: 403 });
    }
    const job = await loadJob(jobId);
    if (!job) return NextResponse.json({ error: SELF_START_SENTENCES.notFound }, { status: 404 });
    if (CLOSED.has(job.status)) {
      return NextResponse.json({ error: closedJobSentence(job.job_number, job.status) }, { status: 400 });
    }

    // The friendly checks first (the database repeats them): a stage of THIS
    // job, still open.
    const stages = await loadStages(jobId);
    const open = openStartStages(stages);
    if (open.length === 0) return NextResponse.json({ error: SELF_START_SENTENCES.noStages }, { status: 400 });
    const stage = stages.find((s) => s.id === body.costCenterId);
    if (!stage) return NextResponse.json({ error: SELF_START_SENTENCES.noStage }, { status: 400 });
    if (stage.completedAt) return NextResponse.json({ error: SELF_START_SENTENCES.stageDone }, { status: 400 });

    const supabase = await callerClient(request);
    const { data, error } = await supabase.rpc("self_start_job_booking", {
      p_booking_id: body.bookingId,
      p_job_id: jobId,
      p_cost_center_id: body.costCenterId,
      p_entry_id: body.entryId,
    });
    if (error) {
      const answer = selfStartRpcError(error, { jobNumber: job.job_number, status: job.status });
      if (answer.status >= 500) {
        console.error("self-start rpc error:", error.code, error.message);
        reportError(new Error(`self_start_job_booking failed (${error.code ?? "no code"})`), { route: "api/jobs/self-start" });
      }
      return NextResponse.json({ error: answer.error }, { status: answer.status });
    }

    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row || typeof row.id !== "string") {
      return NextResponse.json({ error: SELF_START_SENTENCES.failed }, { status: 500 });
    }
    // Only the booking's own window fields — the answer is built field by field.
    return NextResponse.json({
      booking: {
        id: row.id,
        job_id: row.job_id,
        staff_id: row.staff_id,
        cost_center_id: row.cost_center_id,
        starts_at: row.starts_at,
        ends_at: row.ends_at ?? null,
        daily: row.daily === true,
        all_day: row.all_day === true,
        created_by: row.created_by ?? null,
      },
      stage: { id: stage.id, name: stage.name, costCentre: stage.costCentre },
    });
  } catch (err) {
    console.error("self-start error:", err);
    reportError(err, { route: "api/jobs/self-start" });
    return NextResponse.json({ error: SELF_START_SENTENCES.failed }, { status: 500 });
  }
}
