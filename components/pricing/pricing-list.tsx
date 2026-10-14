"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DollarSign } from "lucide-react";
import { pricingTypeColors } from "@/lib/badge-colors";
import { PRICING_LIST_COLUMNS, PRICING_PAGE_SIZE, type PricingListRow } from "@/lib/pricing-list";

// Same paging as InvoiceList: the first page arrives server-rendered, later
// pages are read here under the viewer's own session. Ordered by category then
// name, with id as the tie-break so range() paging cannot skip or repeat a row
// at a page boundary. Grouping happens over everything loaded so far, so a
// category split across pages still shows under one heading.
export function PricingList({ initialItems, total }: { initialItems: PricingListRow[]; total: number }) {
  const [items, setItems] = useState(initialItems);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasMore = items.length < total;

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    setError(null);
    const from = items.length;
    const { data, error: moreError } = await createClient()
      .from("pricing_items")
      .select(PRICING_LIST_COLUMNS)
      .order("category")
      .order("name")
      .order("id")
      .range(from, from + PRICING_PAGE_SIZE - 1);
    setLoadingMore(false);
    if (moreError) {
      setError(moreError.message);
      return;
    }
    setItems([...items, ...((data ?? []) as PricingListRow[])]);
  }

  const grouped = items.reduce((acc: Record<string, PricingListRow[]>, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {});

  return (
    <>
      {Object.keys(grouped).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-slate-400">
            <DollarSign className="w-12 h-12 mb-3 opacity-40" />
            <p className="text-sm font-medium">No pricing items yet</p>
            <Link href="/dashboard/pricing/new" className="mt-2 text-sm text-blue-600 hover:underline">Add your first pricing item</Link>
          </CardContent>
        </Card>
      ) : (
        Object.entries(grouped).map(([category, categoryItems]) => (
          <div key={category} className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider px-1">{category}</h2>
            <Card>
              <CardContent className="p-0">
                <div className="divide-y">
                  {categoryItems.map((item) => (
                    <Link prefetch={false} key={item.id} href={`/dashboard/pricing/${item.id}`} className="flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition-colors group">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm group-hover:text-blue-600 transition-colors truncate">{item.name}</p>
                        {item.description && <p className="text-xs text-slate-500 mt-0.5 truncate">{item.description}</p>}
                      </div>
                      <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${pricingTypeColors[item.pricing_type]}`}>
                          {item.pricing_type.replace("_", " ")}
                        </span>
                        <span className="text-sm font-semibold text-slate-700">
                          ${Number(item.unit_price).toLocaleString("en-AU", { minimumFractionDigits: 2 })} / {item.unit}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        ))
      )}

      {error && <p className="text-sm text-red-500 text-center">Error: {error}</p>}

      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading..." : `Load more (${total - items.length} more)`}
          </Button>
        </div>
      )}
    </>
  );
}
