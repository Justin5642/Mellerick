import { NextRequest, NextResponse } from "next/server";
import { getXeroClient } from "@/lib/xero";
import { createClient } from "@/lib/supabase/server";
import { Invoice, LineItem, Contact, Invoices, LineAmountTypes } from "xero-node";

async function getRefreshedXero() {
  const supabase = await createClient();
  const { data: tokenRow } = await supabase.from("xero_tokens").select("*").single();
  if (!tokenRow) throw new Error("Xero not connected");

  const xero = getXeroClient();
  xero.setTokenSet({
    access_token: tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expires_in: Math.floor((new Date(tokenRow.token_expiry).getTime() - Date.now()) / 1000),
  });

  if (new Date(tokenRow.token_expiry) < new Date()) {
    const newTokenSet = await xero.refreshToken();
    await supabase.from("xero_tokens").update({
      access_token: newTokenSet.access_token!,
      refresh_token: newTokenSet.refresh_token!,
      token_expiry: new Date(Date.now() + (newTokenSet.expires_in as number) * 1000).toISOString(),
    }).eq("id", tokenRow.id);
  }

  return { xero, tenantId: tokenRow.tenant_id };
}

export async function POST(request: NextRequest) {
  try {
    const { invoiceId } = await request.json();
    const supabase = await createClient();

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
      status: Invoice.StatusEnum.AUTHORISED,
    };

    const response = await xero.accountingApi.createInvoices(tenantId, { invoices: [xeroInvoice] });
    const created = response.body.invoices?.[0];

    await supabase.from("invoices").update({
      xero_invoice_id: created?.invoiceID,
      status: "sent",
    }).eq("id", invoiceId);

    return NextResponse.json({ success: true, xeroInvoiceId: created?.invoiceID });
  } catch (err: any) {
    console.error("Push to Xero error:", err);
    return NextResponse.json({ error: err.message ?? "Failed to push to Xero" }, { status: 500 });
  }
}
