export const dynamic = "force-dynamic";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { SupplierInvoiceUpload, type SupplierInvoiceRow } from "@/components/supplier-invoices/supplier-invoice-upload";

// Supplier invoices dropped in by the office (0103).
// Under Supplier POs so it inherits that page's office-only rule
// (lib/nav-items.ts) — RLS on supplier_invoices is the real boundary.
export default async function SupplierInvoicesPage() {
  const supabase = await createClient();
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data, error } = await supabase
    .from("supplier_invoices")
    .select("*")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .order("index_in_file", { ascending: true })
    .limit(500);
  if (error) console.error("supplier invoices load failed:", error.message);

  return (
    <div className="p-6 max-w-6xl space-y-6">
      <div className="flex items-center gap-3">
        <Link prefetch={false} href="/dashboard/supplier-pos">
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500"><ArrowLeft className="w-4 h-4" />Supplier POs</Button>
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">Supplier invoices</h1>
      </div>
      <SupplierInvoiceUpload initial={(data ?? []) as SupplierInvoiceRow[]} loadFailed={!!error} />
    </div>
  );
}
