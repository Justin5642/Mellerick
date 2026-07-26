import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { renderDocumentPdf } from "@/lib/pdf/render";
import { businessInfo } from "@/lib/business-info";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Office/admin-only; Bearer (mobile) or cookie (web) via a caller-scoped client.
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const supabase = await callerClient(request);

  const { data: invoice } = await supabase
    .from("invoices")
    .select("*, customers(name, email, phone), invoice_items(*)")
    .eq("id", id)
    .single();

  if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

  const buffer = await renderDocumentPdf({
    docType: "Tax Invoice",
    docNumber: invoice.invoice_number,
    customer: invoice.customers,
    items: invoice.invoice_items ?? [],
    subtotal: Number(invoice.subtotal),
    taxAmount: Number(invoice.tax_amount),
    total: Number(invoice.total),
    createdAt: invoice.created_at,
    dateLabel: "Due Date",
    dateValue: invoice.due_date,
    notes: invoice.notes,
    workDescription: invoice.work_description,
    business: businessInfo,
  });

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="invoice-${invoice.invoice_number}.pdf"`,
    },
  });
}
