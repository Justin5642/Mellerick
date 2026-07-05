"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function EditInventoryPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [form, setForm] = useState({
    name: "", sku: "", description: "", category: "", unit: "each",
    quantity_on_hand: "0", reorder_level: "0", unit_cost: "0", unit_sell: "0", supplier: "",
    is_active: true,
  });

  useEffect(() => {
    async function load() {
      const { data: item, error } = await supabase.from("inventory").select("*").eq("id", id).single();
      if (error || !item) {
        toast.error("Could not load inventory item");
        router.push("/dashboard/inventory");
        return;
      }
      setForm({
        name: item.name ?? "",
        sku: item.sku ?? "",
        description: item.description ?? "",
        category: item.category ?? "",
        unit: item.unit ?? "each",
        quantity_on_hand: String(item.quantity_on_hand ?? 0),
        reorder_level: String(item.reorder_level ?? 0),
        unit_cost: String(item.unit_cost ?? 0),
        unit_sell: String(item.unit_sell ?? 0),
        supplier: item.supplier ?? "",
        is_active: item.is_active ?? true,
      });
      setFetching(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function set(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.from("inventory").update({
      name: form.name,
      sku: form.sku || null,
      description: form.description,
      category: form.category,
      unit: form.unit,
      quantity_on_hand: parseFloat(form.quantity_on_hand) || 0,
      reorder_level: parseFloat(form.reorder_level) || 0,
      unit_cost: parseFloat(form.unit_cost) || 0,
      unit_sell: parseFloat(form.unit_sell) || 0,
      supplier: form.supplier,
      is_active: form.is_active,
    }).eq("id", id);
    if (error) {
      toast.error(error.message);
      setLoading(false);
    } else {
      toast.success("Inventory item updated");
      router.push(`/dashboard/inventory/${id}`);
      router.refresh();
    }
  }

  if (fetching) return <div className="p-6 text-slate-400 text-sm">Loading...</div>;

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/dashboard/inventory/${id}`}>
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">Edit Inventory Item</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Item Details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Item Name *</Label>
                <Input id="name" value={form.name} onChange={(e) => set("name", e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sku">SKU / Part Number</Label>
                <Input id="sku" value={form.sku} onChange={(e) => set("sku", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="category">Category</Label>
                <Input id="category" value={form.category} onChange={(e) => set("category", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="supplier">Supplier</Label>
                <Input id="supplier" value={form.supplier} onChange={(e) => set("supplier", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="unit">Unit</Label>
                <Input id="unit" value={form.unit} onChange={(e) => set("unit", e.target.value)} />
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
              <Textarea id="description" value={form.description} onChange={(e) => set("description", e.target.value)} rows={2} />
            </div>
            <div className="flex items-center gap-2">
              <input
                id="is_active"
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm((prev) => ({ ...prev, is_active: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-300"
              />
              <Label htmlFor="is_active" className="cursor-pointer">Active item</Label>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Link href={`/dashboard/inventory/${id}`}><Button variant="outline" type="button">Cancel</Button></Link>
          <Button type="submit" disabled={loading}>{loading ? "Saving..." : "Save Changes"}</Button>
        </div>
      </form>
    </div>
  );
}
