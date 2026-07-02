export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { InvoiceDetail } from "@/components/invoice/invoice-detail";

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: invoice }, { data: xeroToken }] = await Promise.all([
    supabase.from("invoices").select("*, customers(name, email, phone), invoice_items(*)").eq("id", id).single(),
    supabase.from("xero_tokens").select("tenant_name").single(),
  ]);

  if (!invoice) notFound();

  return <InvoiceDetail invoice={invoice} xeroConnected={!!xeroToken} />;
}
