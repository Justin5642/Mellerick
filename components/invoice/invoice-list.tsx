"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Receipt } from "lucide-react";
import { formatDate } from "@/lib/date";
import { formatInvoiceNumber } from "@/lib/utils";
import { invoiceStatusColors } from "@/lib/badge-colors";
import { INVOICE_LIST_COLUMNS, INVOICE_PAGE_SIZE, type InvoiceListRow } from "@/lib/invoice-list";

// The first page arrives server-rendered; later pages are read here under the
// viewer's own session, so RLS decides exactly what it did for the first page.
// Ordered newest first with id as a tie-break: imported invoices can share a
// created_at, and range() paging over a non-unique order can skip or repeat
// rows at a page boundary.
export function InvoiceList({ initialInvoices, total }: { initialInvoices: InvoiceListRow[]; total: number }) {
  const [invoices, setInvoices] = useState(initialInvoices);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasMore = invoices.length < total;

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    setError(null);
    const from = invoices.length;
    const { data, error: moreError } = await createClient()
      .from("invoices")
      .select(INVOICE_LIST_COLUMNS)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + INVOICE_PAGE_SIZE - 1);
    setLoadingMore(false);
    if (moreError) {
      setError(moreError.message);
      return;
    }
    setInvoices([...invoices, ...((data ?? []) as InvoiceListRow[])]);
  }

  return (
    <>
      <Card>
        <CardContent className="p-0">
          {invoices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <Receipt className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm font-medium">No invoices yet</p>
              <Link href="/dashboard/invoices/new" className="mt-2 text-sm text-blue-600 hover:underline">Create your first invoice</Link>
            </div>
          ) : (
            <div className="divide-y">
              {invoices.map((inv) => (
                <Link key={inv.id} href={`/dashboard/invoices/${inv.id}`} className="flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition-colors group">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm group-hover:text-blue-600 transition-colors truncate">
                      {formatInvoiceNumber(inv.invoice_number)} — {inv.title}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {inv.customers?.name} · Due {inv.due_date ? formatDate(inv.due_date) : "—"}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                    <span className="text-sm font-semibold text-slate-700">${Number(inv.total).toLocaleString("en-AU", { minimumFractionDigits: 2 })}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${invoiceStatusColors[inv.status]}`}>{inv.status}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {error && <p className="text-sm text-red-500 text-center">Error: {error}</p>}

      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading..." : `Load more (${total - invoices.length} more)`}
          </Button>
        </div>
      )}
    </>
  );
}
