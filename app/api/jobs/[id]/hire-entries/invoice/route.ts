import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { moneyTotals } from "@/lib/replace-line-items";
import {
  dayWorksInvoiceTitle,
  hireOptionLabel,
  invoiceLinesFromEntries,
  optionFor,
  type HireOption,
  type InvoiceableEntry,
} from "@/lib/hire-pricing";

// "Invoice Day Works" (Stage 1, Nov 2026): signed, un-invoiced Day Works
// entries on one job become one ordinary draft invoice (invoices +
// invoice_items), titled "Day Works / Hire — <period>", with lines priced by
// lib/hire-pricing.ts. Kept apart from the builder's quoted work: it never
// reads or writes purchase_orders or any progress-claim field, and it never
// clears the job's Ready-to-Invoice flag (that belongs to the quoted work).
//
// Office/admin only, and everything runs as the caller under RLS — the rate
// tables and invoices are theirs to read and write anyway. Not atomic, so each
// step is checked and a failure removes the invoice it made: deleting it puts
// any entries already marked back to "signed" (FK set null + the guard trigger).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  if (!UUID.test(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const b = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(b.entryIds) ? [...new Set(b.entryIds.filter((x): x is string => typeof x === "string" && UUID.test(x)))] : [];
  if (ids.length === 0) return NextResponse.json({ error: "Tick the Day Works entries to invoice." }, { status: 400 });
  if (ids.length > 500) return NextResponse.json({ error: "Invoice at most 500 entries at a time." }, { status: 400 });

  try {
    const supabase = await callerClient(request);

    const { data: job, error: jobErr } = await supabase.from("jobs").select("id, customer_id, job_number").eq("id", jobId).maybeSingle();
    if (jobErr) throw jobErr;
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    if (!job.customer_id) return NextResponse.json({ error: "This job has no customer to invoice." }, { status: 400 });

    const { data: rows, error: entriesErr } = await supabase
      .from("hire_entries")
      .select("id, equipment_id, hire_type, hire_unit, work_date, hours, days, meter_open, meter_close, km, pickup, dropoff, description, signer_name, status, invoice_id, cost_centre_id, hire_entry_attachments(attachment_id)")
      .eq("job_id", jobId)
      .in("id", ids);
    if (entriesErr) throw entriesErr;
    type Raw = Omit<InvoiceableEntry, "attachment_ids"> & { invoice_id: string | null; hire_entry_attachments: { attachment_id: string }[] | null };
    const raw = (rows ?? []) as unknown as Raw[];
    if (raw.length !== ids.length || raw.some((e) => e.status !== "signed" || e.invoice_id)) {
      return NextResponse.json({ error: "Some of those entries are no longer signed and waiting to be invoiced. Refresh and pick again." }, { status: 409 });
    }
    const entries: InvoiceableEntry[] = raw.map(({ hire_entry_attachments, ...e }) => ({
      ...e,
      attachment_ids: (hire_entry_attachments ?? []).map((a) => a.attachment_id),
    }));

    const equipmentIds = [...new Set(entries.map((e) => e.equipment_id))];
    const attachmentIds = [...new Set(entries.flatMap((e) => e.attachment_ids))];
    const [optionsRes, equipmentRes, attachmentsRes] = await Promise.all([
      supabase
        .from("equipment_hire_options")
        .select("equipment_id, hire_type, hire_unit, rate, whole_days_only, float_base, float_km_included, float_per_km, cost_centre_id")
        .in("equipment_id", equipmentIds),
      supabase.from("equipment").select("id, name").in("id", equipmentIds),
      attachmentIds.length > 0
        ? supabase.from("hire_attachments").select("id, name, day_rate").in("id", attachmentIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (optionsRes.error) throw optionsRes.error;
    if (equipmentRes.error) throw equipmentRes.error;
    if (attachmentsRes.error) throw attachmentsRes.error;

    const options = (optionsRes.data ?? []) as HireOption[];
    const names = new Map((equipmentRes.data ?? []).map((e) => [e.id as string, e.name as string]));
    const unpriced = entries.filter((e) => !optionFor(e, options));
    if (unpriced.length > 0) {
      const which = [...new Set(unpriced.map((e) => `${names.get(e.equipment_id) ?? "a machine"} (${hireOptionLabel(e).toLowerCase()})`))].join(", ");
      return NextResponse.json({ error: `No hire rate is set up for ${which}. Set it in Fleet → Hire setup, then invoice.` }, { status: 400 });
    }

    const lines = invoiceLinesFromEntries(entries, options, attachmentsRes.data ?? [], names);
    const { subtotal, tax, total } = moneyTotals(lines);
    const dates = entries.map((e) => e.work_date).sort();
    // The period chosen on screen, widened if needed so it covers every entry.
    const first = dates[0];
    const last = dates[dates.length - 1];
    const from = typeof b.from === "string" && DATE.test(b.from) && b.from <= first ? b.from : first;
    const to = typeof b.to === "string" && DATE.test(b.to) && b.to >= last ? b.to : last;

    const { data: invoice, error: invErr } = await supabase
      .from("invoices")
      .insert({
        customer_id: job.customer_id,
        job_id: jobId,
        title: dayWorksInvoiceTitle(from, to),
        status: "draft",
        subtotal,
        tax_amount: tax,
        total,
        created_by: guard.userId,
      })
      .select("id, invoice_number")
      .single();
    if (invErr || !invoice) throw invErr ?? new Error("no invoice row returned");

    const undo = async () => {
      const { error } = await supabase.from("invoices").delete().eq("id", invoice.id);
      if (error) console.error("day works invoice cleanup failed:", error);
      return !error;
    };

    const { error: itemsErr } = await supabase.from("invoice_items").insert(
      lines.map((l) => ({ invoice_id: invoice.id, name: l.name, description: l.description, quantity: l.quantity, unit_price: l.unit_price }))
    );
    if (itemsErr) {
      console.error("day works invoice lines error:", itemsErr);
      reportError(itemsErr, { route: "api/jobs/hire-entries/invoice" });
      const cleaned = await undo();
      return NextResponse.json(
        { error: cleaned ? "The invoice lines didn't save, so no invoice was made. Try again." : "The invoice lines didn't save. An empty draft invoice was left — delete it before trying again." },
        { status: 500 }
      );
    }

    const { data: marked, error: markErr } = await supabase
      .from("hire_entries")
      .update({ status: "invoiced", invoice_id: invoice.id })
      .in("id", ids)
      .eq("status", "signed")
      .select("id");
    if (markErr || (marked ?? []).length !== ids.length) {
      if (markErr) {
        console.error("day works mark invoiced error:", markErr);
        reportError(markErr, { route: "api/jobs/hire-entries/invoice" });
      }
      const cleaned = await undo();
      return NextResponse.json(
        { error: cleaned ? "The entries couldn't be marked as invoiced, so no invoice was made. Refresh and try again." : "The entries couldn't be marked as invoiced and the draft invoice couldn't be removed — delete it before trying again." },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, lines: lines.length, subtotal });
  } catch (err) {
    console.error("day works invoice error:", err);
    reportError(err, { route: "api/jobs/hire-entries/invoice" });
    return NextResponse.json({ error: "Couldn't make the Day Works invoice. Try again." }, { status: 500 });
  }
}
