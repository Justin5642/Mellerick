import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renderDocumentPdf } from "@/lib/pdf/render";
import { businessInfo } from "@/lib/business-info";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: quote } = await supabase
    .from("quotes")
    .select("*, customers(name, email, phone), quote_items(*)")
    .eq("id", id)
    .single();

  if (!quote) return NextResponse.json({ error: "Quote not found" }, { status: 404 });

  const buffer = await renderDocumentPdf({
    docType: "Quote",
    docNumber: quote.quote_number,
    customer: quote.customers,
    items: quote.quote_items ?? [],
    subtotal: Number(quote.subtotal),
    taxAmount: Number(quote.tax_amount),
    total: Number(quote.total),
    createdAt: quote.created_at,
    dateLabel: "Valid Until",
    dateValue: quote.valid_until,
    notes: quote.notes,
    business: businessInfo,
  });

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="quote-${quote.quote_number}.pdf"`,
    },
  });
}
