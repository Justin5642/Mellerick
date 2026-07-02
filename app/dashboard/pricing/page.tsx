import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DollarSign, Plus } from "lucide-react";
import Link from "next/link";

const typeColors: Record<string, string> = {
  flat_rate: "bg-blue-100 text-blue-700",
  hourly: "bg-violet-100 text-violet-700",
  material: "bg-orange-100 text-orange-700",
};

export default async function PricingPage() {
  const supabase = await createClient();
  const { data: items } = await supabase
    .from("pricing_items")
    .select("*")
    .order("category")
    .order("name");

  const grouped = (items ?? []).reduce((acc: any, item: any) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {});

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

      {Object.keys(grouped).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-slate-400">
            <DollarSign className="w-12 h-12 mb-3 opacity-40" />
            <p className="text-sm font-medium">No pricing items yet</p>
            <Link href="/dashboard/pricing/new" className="mt-2 text-sm text-blue-600 hover:underline">Add your first pricing item</Link>
          </CardContent>
        </Card>
      ) : (
        Object.entries(grouped).map(([category, categoryItems]: any) => (
          <div key={category} className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider px-1">{category}</h2>
            <Card>
              <CardContent className="p-0">
                <div className="divide-y">
                  {categoryItems.map((item: any) => (
                    <Link key={item.id} href={`/dashboard/pricing/${item.id}`} className="flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition-colors group">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm group-hover:text-blue-600 transition-colors truncate">{item.name}</p>
                        {item.description && <p className="text-xs text-slate-500 mt-0.5 truncate">{item.description}</p>}
                      </div>
                      <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${typeColors[item.pricing_type]}`}>
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
    </div>
  );
}
