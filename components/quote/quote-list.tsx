"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileText } from "lucide-react";
import { formatDate } from "@/lib/date";
import { quoteStatusColors } from "@/lib/badge-colors";
import { QUOTE_LIST_COLUMNS, QUOTE_PAGE_SIZE, type QuoteListRow } from "@/lib/quote-list";

// Same paging as InvoiceList: the first page arrives server-rendered, later
// pages are read here under the viewer's own session (RLS decides exactly as
// it did for the first page), newest first with id as the tie-break so
// range() paging cannot skip or repeat a row at a page boundary.
export function QuoteList({ initialQuotes, total }: { initialQuotes: QuoteListRow[]; total: number }) {
  const [quotes, setQuotes] = useState(initialQuotes);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasMore = quotes.length < total;

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    setError(null);
    const from = quotes.length;
    const { data, error: moreError } = await createClient()
      .from("quotes")
      .select(QUOTE_LIST_COLUMNS)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + QUOTE_PAGE_SIZE - 1);
    setLoadingMore(false);
    if (moreError) {
      setError(moreError.message);
      return;
    }
    setQuotes([...quotes, ...((data ?? []) as QuoteListRow[])]);
  }

  return (
    <>
      <Card>
        <CardContent className="p-0">
          {quotes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <FileText className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm font-medium">No quotes yet</p>
              <Link href="/dashboard/quotes/new" className="mt-2 text-sm text-blue-600 hover:underline">Create your first quote</Link>
            </div>
          ) : (
            <div className="divide-y">
              {quotes.map((quote) => (
                <Link prefetch={false} key={quote.id} href={`/dashboard/quotes/${quote.id}`} className="flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition-colors group">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm group-hover:text-blue-600 transition-colors truncate">
                      #{quote.quote_number} — {quote.title}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">{quote.customers?.name} · {formatDate(quote.created_at)}</p>
                  </div>
                  <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                    <span className="text-sm font-semibold text-slate-700">${Number(quote.total).toLocaleString("en-AU", { minimumFractionDigits: 2 })}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${quoteStatusColors[quote.status]}`}>{quote.status}</span>
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
            {loadingMore ? "Loading..." : `Load more (${total - quotes.length} more)`}
          </Button>
        </div>
      )}
    </>
  );
}
