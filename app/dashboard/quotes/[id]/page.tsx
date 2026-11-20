export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { QuoteDetail } from "@/components/quote/quote-detail";
import { loadBillingAddress } from "@/lib/customer-address-load";

export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: quote } = await supabase
    .from("quotes")
    .select("*, customers(name, company, email, phone), quote_items(*)")
    .eq("id", id)
    .single();

  if (!quote) notFound();
  const billingAddress = await loadBillingAddress(supabase, quote.customer_id);

  return <QuoteDetail quote={quote} billingAddress={billingAddress} />;
}
