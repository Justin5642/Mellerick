import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Package, Plus, AlertTriangle } from "lucide-react";
import Link from "next/link";

export default async function InventoryPage() {
  const supabase = await createClient();
  const { data: items } = await supabase
    .from("inventory")
    .select("*")
    .eq("is_active", true)
    .order("name");

  const lowStock = items?.filter((i: any) => Number(i.quantity_on_hand) <= Number(i.reorder_level)) ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Inventory</h1>
          <p className="text-slate-500 text-sm mt-1">{items?.length ?? 0} items · {lowStock.length} low stock</p>
        </div>
        <Link href="/dashboard/inventory/new">
          <Button className="gap-2"><Plus className="w-4 h-4" />Add Item</Button>
        </Link>
      </div>

      {lowStock.length > 0 && (
        <div className="flex items-center gap-3 bg-orange-50 border border-orange-200 text-orange-800 rounded-lg px-4 py-3 text-sm">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{lowStock.length} item{lowStock.length > 1 ? "s" : ""} at or below reorder level: {lowStock.map((i: any) => i.name).join(", ")}</span>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {!items || items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <Package className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm font-medium">No inventory items yet</p>
              <Link href="/dashboard/inventory/new" className="mt-2 text-sm text-blue-600 hover:underline">Add your first item</Link>
            </div>
          ) : (
            <div className="divide-y">
              {items.map((item: any) => {
                const isLow = Number(item.quantity_on_hand) <= Number(item.reorder_level);
                return (
                  <Link key={item.id} href={`/dashboard/inventory/${item.id}`} className="flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition-colors group">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm group-hover:text-blue-600 transition-colors truncate">{item.name}</p>
                        {isLow && <AlertTriangle className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" />}
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5">{item.category ?? "—"} {item.sku ? `· SKU: ${item.sku}` : ""}</p>
                    </div>
                    <div className="flex items-center gap-4 ml-4 flex-shrink-0 text-right">
                      <div>
                        <p className={`text-sm font-semibold ${isLow ? "text-orange-600" : "text-slate-700"}`}>
                          {item.quantity_on_hand} {item.unit}
                        </p>
                        <p className="text-xs text-slate-400">Reorder at {item.reorder_level}</p>
                      </div>
                      <p className="text-sm text-slate-500 hidden sm:block">${Number(item.unit_sell).toFixed(2)}</p>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
