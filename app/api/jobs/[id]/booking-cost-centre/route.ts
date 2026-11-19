import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { nextJobPoNumber } from "@/lib/job-po-number";
import { planBookingLine, type PoForBookingLine } from "@/lib/booking-cost-centre";

// "Add to this job" in a booking's cost centre picker (19 Nov 2026 — bookings
// always ask for a cost centre). A booking's cost centre is one of the job's
// PO lines; when the job has no line for the company cost centre picked, this
// adds a $0 one to the job's first PO, or makes the job's `<job number>-1` PO
// at $0 first (lib/booking-cost-centre.ts planBookingLine). A line already
// tagged with that cost centre is reused, so a retry adds nothing.
//
// Used by the website's Schedule dialog and board, the phone's Schedule sheet
// (online) and — as a queued side effect after an offline New Job — with
// `applyToBookings`, which gives the job's bookings that have no cost centre
// this line.
//
// Office/admin only (requireOfficeOrAdmin) and every read and write runs as
// the CALLER (callerClient) — RLS on purchase_orders / po_cost_centers /
// job_bookings (office/admin) still decides. The answer carries names and ids
// only, no money. Refusals answer 400/403, never 404: the phone's outbox
// would retry a 404 for ever.

type Ctx = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

const FAILED = "Couldn't add the cost centre to this job. Try again.";

type RawPo = {
  id: string;
  po_number: string;
  po_cost_centers: { id: string; name: string; cost_centre_id: string | null; sort_order: number | null }[] | null;
};

export async function POST(request: NextRequest, { params }: Ctx) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { id: jobId } = await params;
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const costCentreId = body.costCentreId;
  const poId = body.poId === undefined || body.poId === null ? null : body.poId;
  const applyToBookings = body.applyToBookings === true;
  if (!isUuid(jobId) || !isUuid(costCentreId) || (poId !== null && !isUuid(poId))) {
    return NextResponse.json({ error: "Pick a cost centre for this job." }, { status: 400 });
  }

  try {
    const supabase = await callerClient(request);

    const { data: job, error: jobError } = await supabase.from("jobs").select("id, job_number").eq("id", jobId).maybeSingle();
    if (jobError) throw jobError;
    if (!job || job.job_number === null || job.job_number === undefined) {
      return NextResponse.json({ error: "That job isn't there any more." }, { status: 400 });
    }

    const { data: centre, error: centreError } = await supabase.from("cost_centres").select("id, name").eq("id", costCentreId).maybeSingle();
    if (centreError) throw centreError;
    if (!centre) return NextResponse.json({ error: "That cost centre isn't on the company list any more." }, { status: 400 });

    const { data: rawPos, error: posError } = await supabase
      .from("purchase_orders")
      .select("id, po_number, po_cost_centers(id, name, cost_centre_id, sort_order)")
      .eq("job_id", jobId)
      .order("created_at");
    if (posError) throw posError;
    const pos: PoForBookingLine[] = ((rawPos ?? []) as unknown as RawPo[]).map((p) => ({
      id: p.id,
      po_number: p.po_number,
      lines: p.po_cost_centers ?? [],
    }));

    const plan = planBookingLine({
      pos,
      centre: { id: centre.id, name: centre.name },
      newPoNumber: nextJobPoNumber(job.job_number, pos.map((p) => p.po_number)),
    });

    let lineId: string;
    let poNumber: string;
    let lineName = centre.name as string;
    let added = false;
    if (plan.kind === "existing") {
      lineId = plan.lineId;
      const owner = pos.find((p) => p.lines.some((l) => l.id === plan.lineId));
      poNumber = owner?.po_number ?? "";
      lineName = owner?.lines.find((l) => l.id === plan.lineId)?.name ?? lineName;
    } else {
      let targetPoId: string;
      if (plan.kind === "new-po") {
        const { data: po, error: poInsertError } = await supabase
          .from("purchase_orders")
          .insert({ ...(poId ? { id: poId } : null), job_id: jobId, po_number: plan.poNumber, total_value: 0, total_hours: 0 })
          .select("id")
          .single();
        if (poInsertError?.code === "42501") {
          return NextResponse.json({ error: "Only the office can add a cost centre to a job." }, { status: 403 });
        }
        if (poInsertError || !po) throw poInsertError ?? new Error("purchase order insert returned nothing");
        targetPoId = po.id;
        poNumber = plan.poNumber;
      } else {
        targetPoId = plan.poId;
        poNumber = pos.find((p) => p.id === plan.poId)?.po_number ?? "";
      }
      const { data: line, error: lineError } = await supabase
        .from("po_cost_centers")
        .insert({ ...plan.line, po_id: targetPoId })
        .select("id")
        .single();
      if (lineError?.code === "42501") {
        return NextResponse.json({ error: "Only the office can add a cost centre to a job." }, { status: 403 });
      }
      if (lineError || !line) throw lineError ?? new Error("line insert returned nothing");
      lineId = line.id;
      added = true;
    }

    if (applyToBookings) {
      // Bookings made with the job (an offline New Job) that have none yet.
      const { error: bookingsError } = await supabase
        .from("job_bookings")
        .update({ cost_center_id: lineId })
        .eq("job_id", jobId)
        .is("cost_center_id", null);
      // A database without job_bookings (0079) has nothing to tag.
      if (bookingsError && !["42P01", "PGRST205"].includes(bookingsError.code ?? "")) throw bookingsError;
    }

    return NextResponse.json({ line: { id: lineId, name: lineName, cost_centre_id: centre.id, po_number: poNumber || null }, added });
  } catch (err) {
    console.error("booking-cost-centre error:", (err as { message?: string })?.message ?? err);
    reportError(err, { route: "api/jobs/booking-cost-centre" });
    return NextResponse.json({ error: FAILED }, { status: 500 });
  }
}
