import { NextRequest, NextResponse } from "next/server";
import { getRefreshedXero, describeXeroError } from "@/lib/xero";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { Invoice, LineItem, Contact, LineAmountTypes } from "xero-node";
import { reportError } from "@/lib/monitoring";

// A user is waiting on this request while it calls Xero.
export const maxDuration = 30;

// The supplier's invoice, entered once against its PO on the job's PO tab,
// becomes a Xero bill (migration 0089, DRAFT, not applied yet; Justin, 31 Oct 2026: bills are typed
// into Xero by hand today — type them here instead, once). Same shape as
// /api/xero/push-expense: a manual button, an AUTHORISED ACCPAY bill coded to
// the default expense account, and a link written back that is the only thing
// stopping a second bill.
//
// The reference carries our PO number and the supplier's invoice number, so
// the bill reconciles against the supplier statement in Xero. A supplier
// picked from the list (0087) is matched by its Xero contact, not by name.

export async function POST(request: NextRequest) {
  try {
    const guard = await requireOfficeOrAdmin(request);
    if (!guard.ok) return guard.response;
    const { orderId } = await request.json().catch(() => ({}));
    if (typeof orderId !== "string") return NextResponse.json({ error: "Order missing" }, { status: 400 });
    const supabase = await callerClient(request);

    const { data: order } = await supabase
      .from("vendor_orders")
      .select("id, po_number, vendor_name, supplier_id, amount, invoice_number, invoice_date, xero_bill_id, description, jobs(job_number, title), suppliers(xero_contact_id)")
      .eq("id", orderId)
      .single();

    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
    if (order.xero_bill_id) return NextResponse.json({ error: "This PO's invoice is already in Xero" }, { status: 400 });
    if (!order.invoice_number || !(Number(order.amount) > 0)) {
      return NextResponse.json({ error: "Enter the supplier's invoice number and amount first" }, { status: 400 });
    }

    const { xero, tenantId, defaultExpenseAccountCode } = await getRefreshedXero();
    if (!defaultExpenseAccountCode) {
      return NextResponse.json(
        { error: "Set a default Xero expense account code in Settings before sending bills to Xero" },
        { status: 400 }
      );
    }

    const job = order.jobs as unknown as { job_number: number | null; title: string | null } | null;
    const xeroContactId = (order.suppliers as unknown as { xero_contact_id: string | null } | null)?.xero_contact_id;
    const contact: Contact = xeroContactId ? { contactID: xeroContactId } : { name: order.vendor_name };

    const lineItems: LineItem[] = [
      {
        description: `${order.po_number} · #${job?.job_number ?? ""} — ${job?.title ?? ""}${order.description ? `: ${order.description}` : ""}`,
        quantity: 1,
        unitAmount: Number(order.amount),
        taxType: "INPUT",
        accountCode: defaultExpenseAccountCode,
      },
    ];

    const bill: Invoice = {
      type: Invoice.TypeEnum.ACCPAY,
      contact,
      lineItems,
      lineAmountTypes: LineAmountTypes.Exclusive,
      date: order.invoice_date ?? undefined,
      invoiceNumber: order.invoice_number,
      reference: `${order.po_number} / JOB-${job?.job_number ?? ""}`,
      status: Invoice.StatusEnum.AUTHORISED,
    };

    const response = await xero.accountingApi.createInvoices(tenantId, { invoices: [bill] });
    const created = response.body.invoices?.[0];

    // The link is the only thing stopping a second bill. Retried, and if it
    // still won't land, the reply says so in words that stop a retry — see
    // push-expense for the history.
    let linkError: { message: string } | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await supabase
        .from("vendor_orders")
        .update({ xero_bill_id: created?.invoiceID, xero_synced_at: new Date().toISOString() })
        .eq("id", orderId);
      linkError = error;
      if (!error) break;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 150 * attempt));
    }

    if (linkError) {
      console.error("Xero bill link write failed after 3 attempts:", linkError.message);
      return NextResponse.json(
        {
          error:
            `The bill WAS created in Xero but could not be linked to ${order.po_number}. ` +
            `DO NOT SEND AGAIN — that would create a duplicate bill. Ask an admin to link Xero bill ${created?.invoiceID} to this PO.`,
          xeroBillId: created?.invoiceID,
          requiresManualReconciliation: true,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ success: true, xeroBillId: created?.invoiceID });
  } catch (err: unknown) {
    console.error("Push vendor order to Xero error:", err);
    reportError(err, { route: "api/xero/push-vendor-order", integration: "xero" });
    const notConnected = err instanceof Error && err.message === "Xero not connected";
    return NextResponse.json(
      { error: notConnected ? "Xero isn't connected. Connect it in Settings first." : `Xero refused the bill: ${describeXeroError(err)}` },
      { status: notConnected ? 409 : 500 }
    );
  }
}
