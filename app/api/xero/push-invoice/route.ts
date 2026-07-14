import { NextRequest, NextResponse } from "next/server";
import { getRefreshedXero } from "@/lib/xero";
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
      .select("*, customers(name, email, phone), invoice_items(*)")
      .eq("id", invoiceId)
      .single();

    if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    if (!invoice.invoice_items || invoice.invoice_items.length === 0) {
      return NextResponse.json({ error: "Invoice has no line items — add items before pushing to Xero" }, { status: 400 });
    }

    const { xero, tenantId } = await getRefreshedXero();

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
      accountCode: "200",
    }));

    const xeroInvoice: Invoice = {
      type: Invoice.TypeEnum.ACCREC,
      contact,
      lineItems,
      lineAmountTypes: LineAmountTypes.Exclusive,
      dueDate: invoice.due_date ? invoice.due_date.split("T")[0] : undefined,
      reference: `INV-${invoice.invoice_number}`,
      // Explicitly set Xero's own InvoiceNumber to match ours, rather than
      // letting Xero auto-assign the next one in its sequence. Xero's live
      // invoice numbering is a long-running plain-numeric series (no "INV-"
      // prefix -- that prefix is purely how we *display* it in this app, see
      // formatInvoiceNumber()); our invoice_number was bumped via migration
      // 0019 to continue right after Xero's existing max so the two stay
      // numerically identical from here on, invoice-for-invoice.
      invoiceNumber: String(invoice.invoice_number),
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

    if (!isUpdate) {
      await supabase.from("invoices").update({
        xero_invoice_id: result?.invoiceID,
        status: "sent",
      }).eq("id", invoiceId);
    }

    return NextResponse.json({ success: true, xeroInvoiceId: result?.invoiceID, updated: isUpdate });
  } catch (err: any) {
    console.error("Push to Xero error:", err);
    return NextResponse.json({ error: err.message ?? "Failed to push to Xero" }, { status: 500 });
  }
}
