// Approving a completed job: build its draft invoice and mark it approved.
//
// This ran in the browser (components/approvals/approvals-client.tsx) as a
// chain of separate writes, and reported success from the browser. It now runs
// on the server (POST /api/jobs/[id]/approve) so the screen only says "approved"
// once every write has been confirmed here.
//
// What changed in WHAT it bills (bug, 14 Nov 2026 — Garden World / #2542): it
// copied job_items and approved variations onto the invoice, and nothing else.
// Clocked hours reached job_items only through the auto "Labour" lines, which
// 0086 switched off on 31 Oct 2026 — so since then every approval dropped the
// job's hours. Now an approval with hours ALWAYS creates the invoice, even with
// no line items, and reports the hours as unpriced: they are priced on the
// invoice with "Apply hourly rate" (lib/invoice-hours.ts), and the automatic
// Xero push is held until they are (Justin's choice: keep pushing AUTHORISED,
// but never push an invoice with unpriced hours on it).
//
// `db` is the caller's own session: RLS and the 0074 triggers apply exactly as
// they did when this ran in the browser. The route checks the admin role first.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveExistingInvoice } from "@/lib/approval-invoice-guard";
import { moneyTotals } from "@/lib/replace-line-items";
import { variationLineDescription } from "@/lib/variation-qty";
import { loadJobHours, unbilledGroups } from "@/lib/invoice-hours";
import { totalHours, type HoursGroup } from "@/lib/approved-hours";

export interface ApproveJobInput {
  jobId: string;
  approverId: string;
  notes?: string | null;
}

export type ApproveJobResult =
  | {
      ok: true;
      invoiceId: string | null;
      invoiceCreated: boolean;
      alreadyPushed: boolean;
      /** Hours on the job not yet priced on any invoice. Xero push is held while > 0. */
      unpricedHours: number;
      hoursGroups: HoursGroup[];
      /** Non-fatal problems the office must see (the approval itself succeeded). */
      warnings: string[];
    }
  | { ok: false; status: number; error: string };

const fail = (status: number, error: string) => ({ ok: false as const, status, error });

export async function approveJob(db: SupabaseClient, input: ApproveJobInput): Promise<ApproveJobResult> {
  const { jobId, approverId } = input;
  const warnings: string[] = [];

  const jobRes = await db
    .from("jobs")
    .select("id, job_number, title, customer_id, customer_po, status, admin_status")
    .eq("id", jobId)
    .maybeSingle();
  if (jobRes.error) return fail(500, `Could not load the job (${jobRes.error.message}).`);
  const job = jobRes.data as any;
  if (!job) return fail(404, "Job not found.");
  if (job.admin_status !== "pending") {
    return fail(409, "This job is no longer waiting for approval — it may have changed since the page loaded. Reload and check it.");
  }

  // FAILS CLOSED — see lib/approval-invoice-guard.ts.
  const guard = resolveExistingInvoice(
    await db.from("invoices").select("id, xero_invoice_id").eq("job_id", jobId).maybeSingle()
  );
  if (!guard.proceed) return fail(409, guard.reason);

  let invoiceId: string | null = guard.invoiceId;
  let invoiceCreated = false;

  // Hours first: if they cannot be read, stop. Approving without them is the bug.
  let hoursGroups: HoursGroup[];
  try {
    hoursGroups = unbilledGroups((await loadJobHours(db, [jobId])).get(jobId) ?? []);
  } catch (e: any) {
    return fail(500, `${e.message}. Approval stopped so the job's hours are not left off the invoice.`);
  }

  if (!invoiceId) {
    const [itemsRes, varsRes] = await Promise.all([
      db.from("job_items").select("pricing_item_id, name, description, quantity, unit_price").eq("job_id", jobId),
      db
        .from("job_variations")
        .select("id, variation_type_id, custom_name, quantity, unit, rate, total_amount, variation_types(name)")
        .eq("job_id", jobId)
        .in("status", ["approved", "auto_approved"])
        .is("invoice_id", null),
    ]);
    if (itemsRes.error) return fail(500, `Could not read the job's line items (${itemsRes.error.message}).`);
    if (varsRes.error) return fail(500, `Could not read the job's variations (${varsRes.error.message}).`);

    const variationLines = ((varsRes.data ?? []) as any[]).map((v) => ({
      variationId: v.id as string,
      pricing_item_id: null,
      name: v.variation_types?.name ?? v.custom_name ?? "Variation",
      description: variationLineDescription(v),
      quantity: 1,
      unit_price: Number(v.total_amount ?? Number(v.rate ?? 0) * Number(v.quantity ?? 0)),
    }));
    const items = [...((itemsRes.data ?? []) as any[]), ...variationLines];

    if (items.length > 0 || hoursGroups.length > 0) {
      const { subtotal, tax, total } = moneyTotals(
        items.map((i) => ({ quantity: Number(i.quantity), unit_price: Number(i.unit_price) }))
      );
      const { data: created, error: invErr } = await db
        .from("invoices")
        .insert({
          customer_id: job.customer_id,
          job_id: jobId,
          customer_po: job.customer_po ?? null,
          title: `#${job.job_number} — ${job.title}`,
          status: "draft",
          subtotal,
          tax_amount: tax,
          total,
          created_by: approverId,
        })
        .select("id")
        .single();
      if (invErr || !created) return fail(500, `The invoice could not be created (${invErr?.message ?? "no row returned"}). The job was not approved.`);

      if (items.length > 0) {
        const { error: itemsErr } = await db.from("invoice_items").insert(
          items.map((i) => ({
            invoice_id: created.id,
            pricing_item_id: i.pricing_item_id ?? null,
            name: i.name,
            description: i.description,
            quantity: i.quantity,
            unit_price: i.unit_price,
          }))
        );
        if (itemsErr) {
          // Nothing has been pushed or approved yet, so the empty header can go.
          const { error: cleanupErr } = await db.from("invoices").delete().eq("id", created.id);
          return fail(
            500,
            `The invoice lines did not save (${itemsErr.message}). The job was not approved.` +
              (cleanupErr ? ` An empty draft invoice was left behind and could not be removed (${cleanupErr.message}) — delete it before approving again.` : "")
          );
        }
      }

      invoiceId = created.id;
      invoiceCreated = true;

      const ids = variationLines.map((v) => v.variationId);
      if (ids.length > 0) {
        const { error: billErr } = await db.from("job_variations").update({ invoice_id: created.id }).in("id", ids);
        if (billErr) warnings.push(`${ids.length} variation(s) were not marked as billed (${billErr.message}). Check them on the job before invoicing again.`);
      }
    }
  }

  // This write is the approval.
  const { error: approveErr, count } = await db
    .from("jobs")
    .update(
      { admin_status: "approved", admin_notes: input.notes?.trim() || null, ready_to_invoice: !invoiceId },
      { count: "exact" }
    )
    .eq("id", jobId)
    .eq("admin_status", "pending");
  if (approveErr || count === 0) {
    return fail(
      approveErr ? 500 : 409,
      (approveErr?.message ?? "The job could not be approved — it may have changed since this page loaded.") +
        (invoiceCreated ? " A draft invoice was created for it; check it before approving again." : "")
    );
  }

  return {
    ok: true,
    invoiceId,
    invoiceCreated,
    alreadyPushed: guard.alreadyPushed,
    unpricedHours: totalHours(hoursGroups),
    hoursGroups,
    warnings,
  };
}
