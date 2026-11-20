import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { copiedJobRow, copyTitle, templatePo, type CopySourceLine } from "@/lib/job-copy";

// "Copy job" (Justin's notebook list, 20 Nov 2026): a new job from this one,
// used as a template — the rules are lib/job-copy.ts. Web job page and the
// phone's job screen (online only) both call it.
//
// Office/admin only (requireOfficeOrAdmin), and every read and write runs as
// the CALLER (callerClient), never the service role, so RLS decides as it
// does for New Job and the PO tab. Fixed sentences only.
//
// Body: { title?: string, newJobId?: uuid }. `newJobId` (a client UUID) makes
// a retry after a lost answer find the job it already made instead of making
// a second one. If the job is made but its template PO can't be, the answer
// still carries the new job (with a `warning`) — the office adds the cost
// centres on the PO tab.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = "That job isn't there any more.";
const FAILED = "Couldn't copy the job. Try again.";
const PO_WARNING = "The job was copied, but its cost centres weren't — add them on the new job's PO tab.";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { id: sourceId } = await params;
  if (!UUID.test(sourceId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const newJobId = typeof body.newJobId === "string" && UUID.test(body.newJobId) ? body.newJobId : null;
  if (body.newJobId !== undefined && !newJobId) return NextResponse.json({ error: "That isn't a job id." }, { status: 400 });

  try {
    const supabase = await callerClient(request);

    if (newJobId) {
      const { data: done, error: doneError } = await supabase.from("jobs").select("id, job_number").eq("id", newJobId).maybeSingle();
      if (doneError) throw doneError;
      if (done) return NextResponse.json({ id: done.id, jobNumber: done.job_number });
    }

    const { data: source, error: sourceError } = await supabase
      .from("jobs")
      .select("id, customer_id, site_id, title, job_type, priority, description")
      .eq("id", sourceId)
      .maybeSingle();
    if (sourceError) throw sourceError;
    if (!source) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

    const title = copyTitle(body.title, source.title ?? "");
    if (!title) return NextResponse.json({ error: "The title is too long (at most 200 characters)." }, { status: 400 });

    const { data: pos, error: posError } = await supabase
      .from("purchase_orders")
      .select("id, created_at, po_cost_centers(name, cost_centre_id, allocated_hours, code, sort_order)")
      .eq("job_id", sourceId)
      .order("created_at", { ascending: true });
    if (posError) throw posError;
    const lines: CopySourceLine[] = (pos ?? []).flatMap((po: { po_cost_centers?: CopySourceLine[] | null }) =>
      [...(po.po_cost_centers ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    );

    const { data: job, error: jobError } = await supabase
      .from("jobs")
      .insert({ ...(newJobId ? { id: newJobId } : {}), ...copiedJobRow(source, title, guard.userId) })
      .select("id, job_number")
      .single();
    if (jobError || !job) {
      if (jobError?.code === "42501") return NextResponse.json({ error: "Only the office can copy a job." }, { status: 403 });
      throw jobError ?? new Error("job insert returned no row");
    }

    const plan = templatePo(job.job_number, lines);
    if (!plan) return NextResponse.json({ id: job.id, jobNumber: job.job_number, poNumber: null });

    const { data: po, error: poError } = await supabase
      .from("purchase_orders")
      .insert({ job_id: job.id, ...plan.po })
      .select("id")
      .single();
    if (poError || !po) {
      console.error("job copy: template PO insert failed", poError?.code, poError?.message);
      return NextResponse.json({ id: job.id, jobNumber: job.job_number, poNumber: null, warning: PO_WARNING });
    }
    const { error: linesError } = await supabase.from("po_cost_centers").insert(plan.lines.map((l) => ({ ...l, po_id: po.id })));
    if (linesError) {
      console.error("job copy: template PO lines insert failed", linesError.code, linesError.message);
      const { error: cleanupError } = await supabase.from("purchase_orders").delete().eq("id", po.id);
      if (cleanupError) console.error("job copy: empty template PO left behind", cleanupError.code);
      return NextResponse.json({ id: job.id, jobNumber: job.job_number, poNumber: null, warning: PO_WARNING });
    }
    return NextResponse.json({ id: job.id, jobNumber: job.job_number, poNumber: plan.po.po_number });
  } catch (err) {
    console.error("job copy error:", (err as { message?: string })?.message ?? err);
    reportError(err, { route: "api/jobs/copy" });
    return NextResponse.json({ error: FAILED }, { status: 500 });
  }
}
