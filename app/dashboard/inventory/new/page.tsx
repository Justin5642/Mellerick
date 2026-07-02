"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function NewInventoryPage() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: "", sku: "", description: "", category: "", unit: "each",
    quantity_on_hand: "0", reorder_level: "0", unit_cost: "0", unit_sell: "0", supplier: "",
  });

  function set(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.from("inventory").insert({
      ...form,
      quantity_on_hand: parseFloat(form.quantity_on_hand),
      reorder_level: parseFloat(form.reorder_level),
      unit_cost: parseFloat(form.unit_cost),
      unit_sell: parseFloat(form.unit_sell),
      sku: form.sku || null,
    });
    if (error) {
      toast.error(error.message);
      setLoading(false);
    } else {
      toast.success("Inventory item added");
      router.push("/dashboard/inventory");
    }
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/inventory">
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">New Inventory Item</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Item Details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Item Name *</Label>
                <Input id="name" value={form.name} onChange={(e) => set("name", e.target.value)} required placeholder="e.g. 15mm Ball Valve" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sku">SKU / Part Number</Label>
                <Input id="sku" value={form.sku} onChange={(e) => set("sku", e.target.value)} placeholder="BV-15MM" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="category">Category</Label>
                <Input id="category" value={form.category} onChange={(e) => set("category", e.target.value)} placeholder="Valves, Fittings, Tools..." />
              </div>
              <div className="space-y-2">
                <Label htmlFor="supplier">Supplier</Label>
                <Input id="supplier" value={form.supplier} onChange={(e) => set("supplier", e.target.value)} placeholder="Reece, Tradelink..." />
              </div>
              <div className="space-y-2">
                <Label htmlFor="unit">Unit</Label>
                <Input id="unit" value={form.unit} onChange={(e) => set("unit", e.target.value)} placeholder="each, m, kg..." />
              </div>
              <div className="space-y-2">
                <Label htmlFor="quantity_on_hand">Qty On Hand</Label>
                <Input id="quantity_on_hand" type="number" step="0.01" value={form.quantity_on_hand} onChange={(e) => set("quantity_on_hand", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="reorder_level">Reorder Level</Label>
                <Input id="reorder_level" type="number" step="0.01" value={form.reorder_level} onChange={(e) => set("reorder_level", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="unit_cost">Cost Price (ex GST)</Label>
                <Input id="unit_cost" type="number" step="0.01" value={form.unit_cost} onChange={(e) => set("unit_cost", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="unit_sell">Sell Price (ex GST)</Label>
                <Input id="unit_sell" type="number" step="0.01" value={form.unit_sell} onChange={(e) => set("unit_sell", e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="Optional notes..." rows={2} />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Link href="/dashboard/inventory"><Button variant="outline" type="button">Cancel</Button></Link>
          <Button type="submit" disabled={loading}>{loading ? "Saving..." : "Add Item"}</Button>
        </div>
      </form>
    </div>
  );
}
