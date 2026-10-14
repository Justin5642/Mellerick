import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";
import { PricingList } from "@/components/pricing/pricing-list";
import { PRICING_LIST_COLUMNS, PRICING_PAGE_SIZE, type PricingListRow } from "@/lib/pricing-list";

export default async function PricingPage() {
  const supabase = await createClient();
  // First page only, with the total so the list knows whether there is more.
  // The rest come 50 at a time via Load more (components/pricing/pricing-list.tsx,
  // same columns and order).
  const { data: items, count } = await supabase
    .from("pricing_items")
    .select(PRICING_LIST_COLUMNS, { count: "exact" })
    .order("category")
    .order("name")
    .order("id")
    .range(0, PRICING_PAGE_SIZE - 1);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Pricing</h1>
          <p className="text-slate-500 text-sm mt-1">Your rate cards and pricing catalogue</p>
        </div>
        <Link href="/dashboard/pricing/new">
          <Button className="gap-2"><Plus className="w-4 h-4" />Add Item</Button>
        </Link>
      </div>

      <PricingList initialItems={(items ?? []) as PricingListRow[]} total={count ?? items?.length ?? 0} />
    </div>
  );
}
