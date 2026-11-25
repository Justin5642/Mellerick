import { NextRequest, NextResponse } from "next/server";
import { requireOnJob } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/monitoring";
import { listJobStages } from "@/lib/builder-po-stages";
import { MISTAKE_SENTENCES, mistakeRpcError, parseRaiseBody } from "@/lib/mistake-raise";
import { loadCrewMistakeState } from "@/lib/mistakes-crew";

// "Log mistake" on a job (Justin, 25 Nov 2026: crew raise, office costs).
// Anyone on the job (office/admin on any job) — web and phone.
//
//   GET  — what the form needs and what the caller has raised here: the
//          categories, the job's stages (names and completion only), the
//          caller's OWN work time entries on the job (to mark as rework), and
//          their mistakes through my_job_mistakes(). NEVER an amount.
//   POST — the mistake, made by raise_job_mistake() run as the CALLER
//          (callerClient, so auth.uid() is them). The function re-checks the
//          job, the category, the stage and that the time entries are the
//          caller's own; it is the crew's only write to job_mistakes, which
//          stays office/admin-only by RLS (0119, a draft not applied yet). Idempotent on the client id.
//
// Reads, and why each client:
//   • po_cost_centers — SERVICE ROLE through listJobStages(), after
//     requireOnJob: it selects names and completion only (the table is
//     office-only by RLS: it carries money).
//   • categories, time entries, the caller's mistakes — the CALLER's client.
// Errors are fixed sentences (lib/mistake-raise.ts); the database's text goes
// to the log only.

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const { id: jobId } = await params;
  const guard = await requireOnJob(request, jobId);
  if (!guard.ok) return guard.response;
  try {
    const supabase = await callerClient(request);
    const stages = await listJobStages(createAdminClient(), jobId);
    const state = await loadCrewMistakeState(supabase, jobId, guard.userId, stages);
    return NextResponse.json(state);
  } catch (err) {
    console.error("job mistakes load error:", err);
    reportError(err, { route: "api/jobs/mistakes" });
    return NextResponse.json({ error: MISTAKE_SENTENCES.loadFailed }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const { id: jobId } = await params;
  const guard = await requireOnJob(request, jobId);
  if (!guard.ok) return guard.response;

  const body = parseRaiseBody(await request.json().catch(() => null));
  if (!body) return NextResponse.json({ error: MISTAKE_SENTENCES.badRequest }, { status: 400 });

  try {
    const supabase = await callerClient(request);
    const { error } = await supabase.rpc("raise_job_mistake", {
      p_id: body.id,
      p_job_id: jobId,
      p_cost_center_id: body.costCenterId,
      p_category_id: body.categoryId,
      p_cause_code: body.causeCode,
      p_description: body.description,
      p_occurred_on: body.occurredOn,
      p_time_entry_ids: body.timeEntryIds,
    });
    if (error) {
      const answer = mistakeRpcError(error);
      if (answer.status >= 500) {
        console.error("raise_job_mistake error:", error.code, error.message);
        reportError(new Error(`raise_job_mistake failed (${error.code ?? "no code"})`), { route: "api/jobs/mistakes" });
      }
      return NextResponse.json({ error: answer.error }, { status: answer.status });
    }
    const stages = await listJobStages(createAdminClient(), jobId);
    const state = await loadCrewMistakeState(supabase, jobId, guard.userId, stages);
    return NextResponse.json({ ...state, saved: { id: body.id } });
  } catch (err) {
    console.error("raise mistake error:", err);
    reportError(err, { route: "api/jobs/mistakes" });
    return NextResponse.json({ error: MISTAKE_SENTENCES.failed }, { status: 500 });
  }
}
