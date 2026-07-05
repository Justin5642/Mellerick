export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Pencil, DollarSign } from "lucide-react";

const typeColors: Record<string, string> = {
  flat_rate: "bg-blue-100 text-blue-700",
  hourly: "bg-violet-100 text-violet-700",
  material: "bg-orange-100 text-orange-700",
};

function money(n: number) {
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2 })}`;
}

export default async function PricingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: item } = await supabase.from("pricing_items").select("*").eq("id", id).single();
  if (!item) notFound();

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <Link href="/dashboard/pricing">
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
        </Link>
        <Link href={`/dashboard/pricing/${id}/edit`}>
          <Button variant="outline" className="gap-2">
            <Pencil className="w-4 h-4" /> Edit
          </Button>
        </Link>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center justify-center w-14 h-14 rounded-full bg-slate-100 text-slate-600 flex-shrink-0">
          <DollarSign className="w-6 h-6" />
        </div>
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-slate-900">{item.name}</h1>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${typeColors[item.pricing_type] ?? ""}`}>
              {item.pricing_type?.replace("_", " ")}
            </span>
            {!item.is_active && (
              <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-500">Inactive</span>
            )}
          </div>
          <p className="text-slate-500 text-sm">{item.category}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">Pricing</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="flex justify-between"><span className="text-slate-500">Price (ex GST)</span><span className="font-semibold">{money(Number(item.unit_price))} / {item.unit}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Category</span><span>{item.category}</span></div>
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
