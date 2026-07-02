"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

const categories = ["Labour", "Materials", "Call Out", "Inspection", "Drainage", "Hot Water", "Gas", "Backflow", "Stormwater", "Other"];

export default function NewPricingItemPage() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: "", description: "", category: "", pricing_type: "flat_rate", unit_price: "", unit: "each",
  });

  function set(field: string, value: string | null) {
    setForm((prev) => ({ ...prev, [field]: value ?? "" }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.from("pricing_items").insert({
      ...form,
      unit_price: parseFloat(form.unit_price),
    });
    if (error) {
      toast.error(error.message);
      setLoading(false);
    } else {
      toast.success("Pricing item added");
      router.push("/dashboard/pricing");
    }
  }

  return (
    <div className="p-6 max-w-xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/pricing">
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">New Pricing Item</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Item Details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Item Name *</Label>
              <Input id="name" value={form.name} onChange={(e) => set("name", e.target.value)} required placeholder="e.g. Call Out Fee" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Category *</Label>
                <Select value={form.category} onValueChange={(v) => set("category", v)} required>
                  <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                  <SelectContent>
                    {categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Pricing Type *</Label>
                <Select value={form.pricing_type} onValueChange={(v) => set("pricing_type", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="flat_rate">Flat Rate</SelectItem>
                    <SelectItem value="hourly">Hourly</SelectItem>
                    <SelectItem value="material">Material / Per Unit</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="unit_price">Price (AUD, ex GST) *</Label>
                <Input id="unit_price" type="number" step="0.01" min="0" value={form.unit_price} onChange={(e) => set("unit_price", e.target.value)} required placeholder="0.00" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="unit">Unit</Label>
                <Input id="unit" value={form.unit} onChange={(e) => set("unit", e.target.value)} placeholder="each, hr, m, etc." />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="Optional description..." rows={2} />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Link href="/dashboard/pricing"><Button variant="outline" type="button">Cancel</Button></Link>
          <Button type="submit" disabled={loading}>{loading ? "Saving..." : "Add Item"}</Button>
        </div>
      </form>
    </div>
  );
}
