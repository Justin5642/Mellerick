"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Trash2, List } from "lucide-react";

interface Props {
  jobId: string;
  lineItems: any[];
  pricingItems: any[];
  onUpdate: (items: any[]) => void;
}

export function JobLineItems({ jobId, lineItems, pricingItems, onUpdate }: Props) {
  const supabase = createClient();
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ pricing_item_id: "", name: "", description: "", quantity: "1", unit_price: "" });

  function set(field: string, value: string | null) {
    setForm((prev) => ({ ...prev, [field]: value ?? "" }));
  }

  function selectPricingItem(id: string) {
    const item = pricingItems.find((p) => p.id === id);
    if (item) {
      setForm((prev) => ({
        ...prev,
        pricing_item_id: id,
        name: item.name,
        description: item.description ?? "",
        unit_price: String(item.unit_price),
      }));
    }
  }

  async function handleAdd() {
    if (!form.name || !form.unit_price) { toast.error("Name and price are required"); return; }
    setSaving(true);
    const { error } = await supabase.from("job_items").insert({
      job_id: jobId,
      pricing_item_id: form.pricing_item_id || null,
      name: form.name,
      description: form.description || null,
      quantity: parseFloat(form.quantity) || 1,
      unit_price: parseFloat(form.unit_price),
    });
    if (error) { toast.error(error.message); setSaving(false); return; }
    const { data } = await supabase.from("job_items").select("*").eq("job_id", jobId).order("created_at");
    onUpdate(data ?? []);
    setForm({ pricing_item_id: "", name: "", description: "", quantity: "1", unit_price: "" });
    setAdding(false);
    toast.success("Item added");
    setSaving(false);
  }

  async function handleDelete(id: string) {
    await supabase.from("job_items").delete().eq("id", id);
    onUpdate(lineItems.filter((i) => i.id !== id));
    toast.success("Item removed");
  }

  const subtotal = lineItems.reduce((sum, i) => sum + Number(i.total ?? 0), 0);
  const gst = subtotal * 0.1;
  const total = subtotal + gst;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Line Items</h2>
          <p className="text-sm text-slate-500">Parts and labour used on this job</p>
        </div>
        <Button onClick={() => setAdding(true)} className="gap-2" disabled={adding}>
          <Plus className="w-4 h-4" />Add Item
        </Button>
      </div>

      {/* Add item form */}
      {adding && (
        <Card className="border-blue-200 bg-blue-50/30">
          <CardHeader><CardTitle className="text-sm">Add Item</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-slate-500 font-medium">From Pricing Catalogue</label>
              <Select value={form.pricing_item_id} onValueChange={(v) => selectPricingItem(v ?? "")}>
                <SelectTrigger className="text-sm"><SelectValue placeholder="Pick from catalogue (optional)" /></SelectTrigger>
                <SelectContent>
                  {pricingItems.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name} — ${p.unit_price}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div className="sm:col-span-2 space-y-1">
                <label className="text-xs text-slate-500 font-medium">Item Name *</label>
                <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Call Out Fee" className="text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-500 font-medium">Qty</label>
                <Input type="number" step="0.01" min="0" value={form.quantity} onChange={(e) => set("quantity", e.target.value)} className="text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-500 font-medium">Unit Price (ex GST) *</label>
                <Input type="number" step="0.01" min="0" value={form.unit_price} onChange={(e) => set("unit_price", e.target.value)} placeholder="0.00" className="text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
              <Button size="sm" onClick={handleAdd} disabled={saving}>{saving ? "Saving..." : "Add"}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Items list */}
      {lineItems.length === 0 && !adding ? (
        <div className="flex flex-col items-center justify-center py-12 text-slate-400 border-2 border-dashed border-slate-200 rounded-xl">
          <List className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm font-medium">No items yet</p>
          <p className="text-xs mt-1">Add parts and labour to this job</p>
        </div>
      ) : lineItems.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-slate-50">
                  <th className="text-left px-4 py-3 font-medium text-slate-500">Item</th>
                  <th className="text-right px-4 py-3 font-medium text-slate-500 w-20">Qty</th>
                  <th className="text-right px-4 py-3 font-medium text-slate-500 w-28">Unit Price</th>
                  <th className="text-right px-4 py-3 font-medium text-slate-500 w-28">Total</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {lineItems.map((item) => (
                  <tr key={item.id} className="group hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{item.name}</p>
                      {item.description && <p className="text-xs text-slate-500">{item.description}</p>}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-700">{item.quantity}</td>
                    <td className="px-4 py-3 text-right text-slate-700">${Number(item.unit_price).toFixed(2)}</td>
                    <td className="px-4 py-3 text-right font-medium text-slate-900">${Number(item.total).toFixed(2)}</td>
                    <td className="px-2 py-3">
                      <button onClick={() => handleDelete(item.id)} className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-red-500 p-1">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Totals */}
            <div className="border-t px-4 py-3 space-y-1.5 bg-slate-50">
              <div className="flex justify-between text-sm text-slate-600">
                <span>Subtotal (ex GST)</span>
                <span>${subtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm text-slate-600">
                <span>GST (10%)</span>
                <span>${gst.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-base font-bold text-slate-900 pt-1 border-t">
                <span>Total</span>
                <span>${total.toFixed(2)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
