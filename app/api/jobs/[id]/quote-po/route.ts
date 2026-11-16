import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { quoteBudgetPo } from "@/lib/quote-job-po";

// The phone's quote → job conversion, last step: the quote's subtotal becomes
// the job's `<job number>-1` purchase order, as the web's Convert to Job does
// (lib/quote-job-po.ts). The phone queues the job insert offline and can't
// know the job number (a database serial) until it has synced, so it queues
// this side effect after the insert and the quote link instead, and the number
// is worked out here, against the job's real number and POs.
//
// Office/admin only — a PO carries money. Every read and the insert run as
// the CALLER (RLS: purchase_orders is office/admin, 0035), never the service
// role. The value is read from the quote, never taken from the request, and
// only from a quote already linked to this job.
//
// Retries are harmless: the phone sends the PO's id (a client UUID), so a
// retry after a lost answer finds that PO and stops. Refusals answer 400/403,
// never 404 — the outbox would retry a 404 forever.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { id: jobId } = await params;
  const b = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const quoteId = typeof b.quoteId === "string" ? b.quoteId : "";
  const poId = typeof b.poId === "string" ? b.poId : "";
  if (!UUID.test(jobId) || !UUID.test(quoteId) || !UUID.test(poId)) {
    return NextResponse.json({ error: "A job, quote and purchase order id are needed." }, { status: 400 });
  }

  try {
    const supabase = await callerClient(request);

    const { data: already, error: alreadyError } = await supabase
      .from("purchase_orders")
      .select("id, po_number")
      .eq("id", poId)
      .maybeSingle();
    if (alreadyError) throw alreadyError;
    if (already) return NextResponse.json({ poNumber: already.po_number });

    const { data: quote, error: quoteError } = await supabase
      .from("quotes")
      .select("id, job_id, subtotal")
      .eq("id", quoteId)
      .maybeSingle();
    if (quoteError) throw quoteError;
    if (!quote || quote.job_id !== jobId) {
      return NextResponse.json({ error: "That quote isn't linked to this job." }, { status: 400 });
    }

    const { data: job, error: jobError } = await supabase
      .from("jobs")
      .select("id, job_number")
      .eq("id", jobId)
      .maybeSingle();
    if (jobError) throw jobError;
    if (!job || job.job_number === null || job.job_number === undefined) {
      return NextResponse.json({ error: "Job not found." }, { status: 400 });
    }

    const { data: pos, error: posError } = await supabase
      .from("purchase_orders")
      .select("po_number")
      .eq("job_id", jobId);
    if (posError) throw posError;

    const po = quoteBudgetPo(
      job.job_number,
      (pos ?? []).map((p: { po_number: string }) => p.po_number),
      quote.subtotal
    );
    if (!po) return NextResponse.json({ poNumber: null });

    const { error: insertError } = await supabase.from("purchase_orders").insert({ id: poId, job_id: jobId, ...po });
    if (insertError) {
      // Two deliveries racing: the other one made it.
      if (insertError.code === "23505" && /purchase_orders_pkey/.test(insertError.message ?? "")) {
        return NextResponse.json({ poNumber: po.po_number });
      }
      if (insertError.code === "42501") {
        return NextResponse.json({ error: "Only the office can add a purchase order." }, { status: 403 });
      }
      throw insertError;
    }
    return NextResponse.json({ poNumber: po.po_number });
  } catch (err) {
    console.error("quote-po error:", (err as { message?: string })?.message ?? err);
    reportError(err, { route: "api/jobs/quote-po" });
    return NextResponse.json({ error: "The quote's purchase order could not be saved." }, { status: 500 });
  }
}
