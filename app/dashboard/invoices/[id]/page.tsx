export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { InvoiceDetail } from "@/components/invoice/invoice-detail";

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: invoice }, { data: xeroToken }, paymentsRes] = await Promise.all([
    supabase.from("invoices").select("*, customers(name, email, phone), invoice_items(*)").eq("id", id).single(),
    supabase.from("xero_tokens").select("tenant_name").single(),
    supabase.from("invoice_payments").select("id, amount, paid_on, method, reference").eq("invoice_id", id).order("paid_on"),
  ]);

  if (!invoice) notFound();

  // A database without invoice_payments (migration 0081, a draft, not applied
  // yet) answers 42P01 / PGRST205: the payments card then says so instead of
  // offering a form that cannot save. Any other error is logged and shows the
  // same way rather than taking the invoice page down.
  if (paymentsRes.error) console.error("invoice page: payments unavailable", paymentsRes.error);
  const payments = paymentsRes.error ? null : paymentsRes.data ?? [];

  return <InvoiceDetail invoice={invoice} xeroConnected={!!xeroToken} payments={payments} />;
}
