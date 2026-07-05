export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { QuoteDetail } from "@/components/quote/quote-detail";

export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: quote } = await supabase
    .from("quotes")
    .select("*, customers(name, email, phone), quote_items(*)")
    .eq("id", id)
    .single();

  if (!quote) notFound();

  return <QuoteDetail quote={quote} />;
}
