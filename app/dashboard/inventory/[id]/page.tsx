export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Pencil, Package, AlertTriangle } from "lucide-react";

function money(n: number) {
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2 })}`;
}

export default async function InventoryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: item } = await supabase.from("inventory").select("*").eq("id", id).single();
  if (!item) notFound();

  const isLow = Number(item.quantity_on_hand) <= Number(item.reorder_level);
  const margin = Number(item.unit_sell) - Number(item.unit_cost);

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <Link href="/dashboard/inventory">
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
        </Link>
        <Link href={`/dashboard/inventory/${id}/edit`}>
          <Button variant="outline" className="gap-2">
            <Pencil className="w-4 h-4" /> Edit
          </Button>
        </Link>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center justify-center w-14 h-14 rounded-full bg-slate-100 text-slate-600 flex-shrink-0">
          <Package className="w-6 h-6" />
        </div>
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-slate-900">{item.name}</h1>
            {isLow && (
              <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-orange-100 text-orange-700">
                <AlertTriangle className="w-3 h-3" /> Low stock
              </span>
            )}
            {!item.is_active && (
              <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-500">Inactive</span>
            )}
          </div>
          <p className="text-slate-500 text-sm">
            {item.category ?? "Uncategorised"} {item.sku ? `· SKU: ${item.sku}` : ""}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-slate-500">Qty On Hand</p>
            <p className={`text-xl font-bold ${isLow ? "text-orange-600" : "text-slate-900"}`}>
              {item.quantity_on_hand} {item.unit}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-slate-500">Reorder Level</p>
            <p className="text-xl font-bold text-slate-900">{item.reorder_level} {item.unit}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-slate-500">Cost Price</p>
            <p className="text-xl font-bold text-slate-900">{money(Number(item.unit_cost))}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-slate-500">Sell Price</p>
            <p className="text-xl font-bold text-slate-900">{money(Number(item.unit_sell))}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">Details</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="flex justify-between"><span className="text-slate-500">Supplier</span><span>{item.supplier || "—"}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Margin</span><span>{money(margin)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Status</span><span>{item.is_active ? "Active" : "Inactive"}</span></div>
          </CardContent>
        </Card>
        {item.description && (
          <Card>
            <CardHeader><CardTitle className="text-sm">Description</CardTitle></CardHeader>
            <CardContent><p className="text-sm text-slate-600 whitespace-pre-wrap">{item.description}</p></CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
