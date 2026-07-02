import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileText, Plus } from "lucide-react";
import Link from "next/link";

const statusColors: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  sent: "bg-blue-100 text-blue-700",
  accepted: "bg-green-100 text-green-700",
  declined: "bg-red-100 text-red-700",
  expired: "bg-orange-100 text-orange-700",
};

export default async function QuotesPage() {
  const supabase = await createClient();
  const { data: quotes } = await supabase
    .from("quotes")
    .select("*, customers(name)")
    .order("created_at", { ascending: false });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Quotes</h1>
          <p className="text-slate-500 text-sm mt-1">{quotes?.length ?? 0} total quotes</p>
        </div>
        <Link href="/dashboard/quotes/new">
          <Button className="gap-2"><Plus className="w-4 h-4" />New Quote</Button>
        </Link>
      </div>

      <Card>
        <CardContent className="p-0">
          {!quotes || quotes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <FileText className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm font-medium">No quotes yet</p>
              <Link href="/dashboard/quotes/new" className="mt-2 text-sm text-blue-600 hover:underline">Create your first quote</Link>
            </div>
          ) : (
            <div className="divide-y">
              {quotes.map((quote: any) => (
                <Link key={quote.id} href={`/dashboard/quotes/${quote.id}`} className="flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition-colors group">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm group-hover:text-blue-600 transition-colors truncate">
                      #{quote.quote_number} — {quote.title}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">{quote.customers?.name} · {new Date(quote.created_at).toLocaleDateString("en-AU")}</p>
                  </div>
                  <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                    <span className="text-sm font-semibold text-slate-700">${Number(quote.total).toLocaleString("en-AU", { minimumFractionDigits: 2 })}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${statusColors[quote.status]}`}>{quote.status}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
