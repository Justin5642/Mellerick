import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";
import { QuoteList } from "@/components/quote/quote-list";
import { QUOTE_LIST_COLUMNS, QUOTE_PAGE_SIZE, type QuoteListRow } from "@/lib/quote-list";

export default async function QuotesPage() {
  const supabase = await createClient();
  // First page only, with the total for the header — every quote with every
  // column used to load here. The rest come 50 at a time via Load more
  // (components/quote/quote-list.tsx, same columns and order).
  const { data: quotes, count: quoteCount } = await supabase
    .from("quotes")
    .select(QUOTE_LIST_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(0, QUOTE_PAGE_SIZE - 1);
  const totalQuotes = quoteCount ?? quotes?.length ?? 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Quotes</h1>
          <p className="text-slate-500 text-sm mt-1">{totalQuotes} total quotes</p>
        </div>
        <Link href="/dashboard/quotes/new">
          <Button className="gap-2"><Plus className="w-4 h-4" />New Quote</Button>
        </Link>
      </div>

      <QuoteList initialQuotes={(quotes ?? []) as QuoteListRow[]} total={totalQuotes} />
    </div>
  );
}
