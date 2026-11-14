import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";

// The office's decision on which job (or overhead) a Xero supplier bill belongs
// to (draft migration 0099, not applied yet). Runs as the CALLER, so RLS —
// office/admin only — is the second lock behind the guard. The amount is never
// taken from the request: it is read from the Xero mirror when needed.

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const body = (await request.json().catch(() => null)) as { kind?: unknown; jobNumber?: unknown; note?: unknown } | null;
  const kind = body?.kind;
  if (kind !== "job" && kind !== "overhead") {
    return NextResponse.json({ error: "Choose a job or overhead" }, { status: 400 });
  }
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;

  const supabase = await callerClient(request);

  const { data: bill, error: billError } = await supabase
    .from("xero_invoices")
    .select("xero_invoice_id, type")
    .eq("xero_invoice_id", id)
    .maybeSingle();
  if (billError) {
    reportError(billError, { route: "api/xero/bills/allocate", integration: "supabase" });
    return NextResponse.json({ error: "Could not look up that bill" }, { status: 500 });
  }
  if (!bill || bill.type !== "ACCPAY") {
    return NextResponse.json({ error: "That is not a supplier bill" }, { status: 404 });
  }

  let jobId: string | null = null;
  if (kind === "job") {
    const jobNumber = Number(body?.jobNumber);
    if (!Number.isInteger(jobNumber) || jobNumber <= 0) {
      return NextResponse.json({ error: "Enter the job number" }, { status: 400 });
    }
    const { data: job, error: jobError } = await supabase.from("jobs").select("id").eq("job_number", jobNumber).maybeSingle();
    if (jobError) {
      reportError(jobError, { route: "api/xero/bills/allocate", integration: "supabase" });
      return NextResponse.json({ error: "Could not look up that job" }, { status: 500 });
    }
    if (!job) return NextResponse.json({ error: `No job #${jobNumber}` }, { status: 404 });
    jobId = job.id;
  }

  const { error } = await supabase
    .from("xero_bill_allocations")
    .upsert({ xero_invoice_id: id, kind, job_id: jobId, note, allocated_at: new Date().toISOString() }, { onConflict: "xero_invoice_id" });
  if (error) {
    reportError(error, { route: "api/xero/bills/allocate", integration: "supabase" });
    return NextResponse.json({ error: "Could not save that" }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}

// Undo a mistaken assignment: the bill goes back to the unallocated list.
export async function DELETE(request: NextRequest, { params }: Ctx) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const supabase = await callerClient(request);
  const { error } = await supabase.from("xero_bill_allocations").delete().eq("xero_invoice_id", id);
  if (error) {
    reportError(error, { route: "api/xero/bills/allocate", integration: "supabase" });
    return NextResponse.json({ error: "Could not undo that" }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
