import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { planBuilderPoEdit } from "@/lib/builder-po";
import {
  isUuidLike,
  linesInUse,
  loadJobForPo,
  loadJobPurchaseOrders,
  loadPo,
  parsePoLines,
  poSiteCoords,
  usageByLine,
} from "@/lib/job-purchase-orders";

// Edit or remove one builder PO from the phone (office/admin; the web's own
// rules, run as the caller). PATCH is the web's savePOEdit: lines updated in
// place by id (supplier orders, time and bookings point at them), new lines
// inserted, removed lines deleted — unless something is recorded against them,
// which is checked HERE from fresh reads, not trusted from the phone. Not
// atomic, like the web: a partial failure answers with what was saved and a
// warning. "Add cost centre to this PO" on the phone is this same edit with
// one more line.

type Ctx = { params: Promise<{ id: string; poId: string }> };

const NOT_FOUND = "That purchase order isn't on this job any more. Refresh to see it.";

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { id: jobId, poId } = await params;
  if (!isUuidLike(jobId) || !isUuidLike(poId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const lines = parsePoLines(body?.lines ?? []);
  if (!lines) return NextResponse.json({ error: "Check the cost centre lines." }, { status: 400 });
  const poNumber = typeof body?.poNumber === "string" ? body.poNumber.trim().slice(0, 100) : "";
  const value = typeof body?.value === "string" ? body.value : typeof body?.value === "number" ? String(body.value) : "";
  const clientReference = typeof body?.clientReference === "string" ? body.clientReference.trim().slice(0, 200) : "";
  const siteAddress = typeof body?.siteAddress === "string" ? body.siteAddress.trim().slice(0, 300) : "";

  try {
    const supabase = await callerClient(request);
    const [job, po] = await Promise.all([loadJobForPo(supabase, jobId), loadPo(supabase, jobId, poId)]);
    if (!job || !po) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

    const lineIds = po.lines.map((l) => l.id);
    const [ordersRes, timeRes, expensesRes, centresRes] = await Promise.all([
      lineIds.length ? supabase.from("vendor_orders").select("cost_center_id").in("cost_center_id", lineIds) : Promise.resolve({ data: [], error: null }),
      supabase.from("time_entries").select("cost_center_id, hours, entry_type").eq("job_id", jobId),
      supabase.from("job_expenses").select("cost_center_id, amount").eq("job_id", jobId),
      supabase.from("cost_centres").select("id, name").eq("is_active", true),
    ]);
    if (ordersRes.error) throw ordersRes.error;
    if (timeRes.error) throw timeRes.error;
    if (expensesRes.error) throw expensesRes.error;
    const ordersByLine: Record<string, number> = {};
    for (const o of (ordersRes.data ?? []) as { cost_center_id: string }[]) ordersByLine[o.cost_center_id] = (ordersByLine[o.cost_center_id] ?? 0) + 1;
    const usage = usageByLine(
      (timeRes.data ?? []) as { cost_center_id: string | null; hours: number | null; entry_type?: string | null }[],
      (expensesRes.data ?? []) as { cost_center_id: string | null; amount: number | null }[]
    );
    // A saved line's own (possibly retired) cost centre still counts as known.
    const centres = [...((centresRes.data ?? []) as { id: string; name: string }[])];
    for (const l of lines) {
      const savedLine = po.lines.find((s) => s.id === l.id);
      if (savedLine?.cost_centre_id && savedLine.cost_centre_id === l.costCentreId && !centres.some((c) => c.id === l.costCentreId)) {
        centres.push({ id: savedLine.cost_centre_id, name: savedLine.name });
      }
    }

    const planned = planBuilderPoEdit(
      { poNumber, value, lines },
      po.lines,
      centres,
      linesInUse(lineIds, ordersByLine, usage.hoursByLine, usage.spentByLine)
    );
    if (!planned.ok) return NextResponse.json({ error: planned.error }, { status: 400 });
    const { updates, inserts, deletes, value: total, totalHours, unallocated } = planned.edit;

    let failed = false;
    const updateResults = await Promise.all(
      updates.map(({ id, ...row }) => supabase.from("po_cost_centers").update(row, { count: "exact" }).eq("id", id).eq("po_id", poId))
    );
    if (updateResults.some((r) => r.error || r.count === 0)) failed = true;
    if (!failed && inserts.length > 0) {
      const { error } = await supabase.from("po_cost_centers").insert(inserts.map((l) => ({ ...l, po_id: poId })));
      if (error) failed = true;
    }
    if (!failed && deletes.length > 0) {
      const { error, count } = await supabase.from("po_cost_centers").delete({ count: "exact" }).in("id", deletes).eq("po_id", poId);
      if (error || count !== deletes.length) failed = true;
    }
    if (!failed) {
      const { error, count } = await supabase
        .from("purchase_orders")
        .update(
          {
            po_number: poNumber,
            client_reference: clientReference || null,
            site_address: siteAddress || null,
            ...poSiteCoords(siteAddress, job.site, po),
            total_value: total,
            total_hours: totalHours,
          },
          { count: "exact" }
        )
        .eq("id", poId)
        .eq("job_id", jobId);
      if (error || count === 0) failed = true;
    }

    const state = await loadJobPurchaseOrders(supabase, jobId);
    const warning = failed
      ? "Some of the PO's changes didn't save. Check it and try again."
      : unallocated > 0
        ? "PO updated — part of its value isn't split yet."
        : undefined;
    return NextResponse.json({ ...state, warning });
  } catch (err) {
    console.error("purchase-orders PATCH error:", err);
    reportError(err, { route: "api/jobs/purchase-orders/[poId]" });
    return NextResponse.json({ error: "Couldn't save the purchase order. Check it and try again." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { id: jobId, poId } = await params;
  if (!isUuidLike(jobId) || !isUuidLike(poId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  try {
    const supabase = await callerClient(request);
    // No error for a DELETE that matches nothing, so `count` tells "removed"
    // from "refused" (the web's deletePO). A retry after a dropped answer
    // finds nothing to remove; it is answered with the tab as it is.
    const { error, count } = await supabase.from("purchase_orders").delete({ count: "exact" }).eq("id", poId).eq("job_id", jobId);
    if (error) throw error;
    const state = await loadJobPurchaseOrders(supabase, jobId);
    if (!state) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    if (count === 0 && state.pos.some((p) => p.id === poId)) {
      return NextResponse.json({ error: "Couldn't remove this purchase order." }, { status: 409 });
    }
    return NextResponse.json(state);
  } catch (err) {
    console.error("purchase-orders DELETE error:", err);
    reportError(err, { route: "api/jobs/purchase-orders/[poId]" });
    return NextResponse.json({ error: "Couldn't remove the purchase order. Try again." }, { status: 500 });
  }
}
