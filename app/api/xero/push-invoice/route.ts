import { NextRequest, NextResponse } from "next/server";
import { getRefreshedXero, describeXeroError } from "@/lib/xero";
import { createClient } from "@/lib/supabase/server";
import { Invoice, LineItem, Contact, Invoices, LineAmountTypes } from "xero-node";

export async function POST(request: NextRequest) {
  try {
    const { invoiceId } = await request.json();
    const supabase = await createClient();

    // Server-side enforcement (not just a UI hint): only admins may push
    // invoices to Xero, whether triggered from the Approvals auto-push or
    // the manual button on the invoice page. Per Justin: technicians must
    // never be able to push invoices, including by calling this API directly.
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role !== "admin") {
      return NextResponse.json({ error: "Only admins can push invoices to Xero" }, { status: 403 });
    }

    const { data: invoice } = await supabase
      .from("invoices")
      .select("*, customers(name, email, phone), jobs(job_number), invoice_items(*)")
      .eq("id", invoiceId)
      .single();

    if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    if (!invoice.invoice_items || invoice.invoice_items.length === 0) {
      return NextResponse.json({ error: "Invoice has no line items — add items before pushing to Xero" }, { status: 400 });
    }

    const { xero, tenantId, defaultSalesAccountCode } = await getRefreshedXero();

    // The sales/income account these lines post to. Previously hardcoded to
    // "200", which was archived in the org's chart of accounts and got EVERY
    // push rejected — now office-configurable (migration 0033), same as the
    // expense account code for Bills. Guard against it being cleared.
    if (!defaultSalesAccountCode) {
      return NextResponse.json(
        { error: "Set a Xero sales account code in Settings before pushing invoices" },
        { status: 400 }
      );
    }

    // Find or create Xero contact
    const contact: Contact = {
      name: invoice.customers.name,
      emailAddress: invoice.customers.email ?? undefined,
      phones: invoice.customers.phone ? [{ phoneType: "DEFAULT" as any, phoneNumber: invoice.customers.phone }] : undefined,
    };

    const lineItems: LineItem[] = invoice.invoice_items.map((item: any) => ({
      description: item.name + (item.description ? ` — ${item.description}` : ""),
      quantity: Number(item.quantity),
      unitAmount: Number(item.unit_price),
      taxType: "OUTPUT",
      accountCode: defaultSalesAccountCode,
    }));

    const xeroInvoice: Invoice = {
      type: Invoice.TypeEnum.ACCREC,
      contact,
      lineItems,
      lineAmountTypes: LineAmountTypes.Exclusive,
      // Xero rejects an AUTHORISED invoice with no due date ("The document
      // DueDate field must be specified."). When the office hasn't set one,
      // fall back to the issue date (due on receipt) so the push succeeds;
      // setting an explicit due_date on the invoice overrides this.
      dueDate: (invoice.due_date ?? invoice.created_at).split("T")[0],
      // Now that Xero owns the invoice number, use the reference to link the
      // invoice back to its job (stable and useful for finding a job's invoice
      // in Xero). Omitted for invoices with no linked job.
      reference: invoice.jobs?.job_number ? `Job #${invoice.jobs.job_number}` : undefined,
      // Xero owns invoice numbering: we let it auto-assign its next number
      // rather than forcing ours. Forcing it (the old approach, migration
      // 0019) only worked while the two sequences stayed aligned -- but
      // invoices are also raised directly in Xero, so Xero's sequence ran
      // ahead and every forced number collided ("Invoice # must be unique").
      // Instead we adopt Xero's assigned number back into our record after a
      // successful create (see below), and keep our original number in the
      // reference field above for traceability.
      status: Invoice.StatusEnum.AUTHORISED,
    };

    // Already pushed once (has a xero_invoice_id) -- push edits forward by
    // updating the same Xero invoice in place, rather than creating a
    // duplicate. First push still creates. Xero will itself reject the
    // update if the invoice has since been paid/voided there, which
    // surfaces as a normal error below -- we don't try to pre-empt that,
    // since the reverse-sync poll is what keeps paid/void status current
    // here and this route doesn't second-guess it.
    const isUpdate = !!invoice.xero_invoice_id;

    const response = isUpdate
      ? await xero.accountingApi.updateInvoice(tenantId, invoice.xero_invoice_id, { invoices: [xeroInvoice] })
      : await xero.accountingApi.createInvoices(tenantId, { invoices: [xeroInvoice] });
    const result = response.body.invoices?.[0];

    let adoptedNumber: number | null = null;
    if (!isUpdate) {
      // Record the Xero link first -- this is what stops a retry from creating
      // a duplicate, so it must land even if the number adoption below fails.
      await supabase.from("invoices").update({
        xero_invoice_id: result?.invoiceID,
        status: "sent",
      }).eq("id", invoiceId);

      // Adopt the number Xero assigned so our record matches Xero's. Xero
      // returns it with the org's prefix (e.g. "INV-12144"), but our
      // invoice_number is an integer that the UI re-prefixes via
      // formatInvoiceNumber() ("INV-" + number) -- so we store just the
      // trailing digits (12144) and the app then displays "INV-12144",
      // identical to Xero. Done as a separate update so a (near-impossible)
      // unique collision on the number can't stop the xero_invoice_id above
      // from being saved.
      const digits = String(result?.invoiceNumber ?? "").match(/(\d+)$/)?.[1];
      const parsed = digits ? parseInt(digits, 10) : NaN;
      if (!Number.isNaN(parsed)) {
        const { error: numErr } = await supabase.from("invoices").update({ invoice_number: parsed }).eq("id", invoiceId);
        if (!numErr) adoptedNumber = parsed;
        else console.error("Xero number adoption failed:", numErr);
      }
    }

    return NextResponse.json({ success: true, xeroInvoiceId: result?.invoiceID, updated: isUpdate, invoiceNumber: adoptedNumber });
  } catch (err: any) {
    console.error("Push to Xero error:", err.response?.body ?? err);
    return NextResponse.json({ error: describeXeroError(err) }, { status: 500 });
  }
}
