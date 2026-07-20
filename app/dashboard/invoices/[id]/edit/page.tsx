"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { FormSkeleton } from "@/components/ui/loading-skeletons";

interface LineItem { id?: string; name: string; description: string; quantity: string; unit_price: string; }

export default function EditInvoicePage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [pricingItems, setPricingItems] = useState<any[]>([]);
  const [form, setForm] = useState({ title: "", customer_id: "", customer_name: "", due_date: "", notes: "", work_description: "" });
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [errors, setErrors] = useState<Record<string, boolean>>({});

  useEffect(() => {
    async function load() {
      const [{ data: invoice }, { data: pricing }] = await Promise.all([
        supabase.from("invoices").select("*, invoice_items(*)").eq("id", id).single(),
        supabase.from("pricing_items").select("*").eq("is_active", true).order("name"),
      ]);
      if (invoice) {
        setForm({
          title: invoice.title,
          customer_id: invoice.customer_id,
          customer_name: "",
          due_date: invoice.due_date ? invoice.due_date.split("T")[0] : "",
          notes: invoice.notes ?? "",
          work_description: invoice.work_description ?? "",
        });
        setLineItems((invoice.invoice_items ?? []).map((i: any) => ({
          id: i.id,
          name: i.name,
          description: i.description ?? "",
          quantity: String(i.quantity),
          unit_price: String(i.unit_price),
        })));
      }
      setPricingItems(pricing ?? []);
      setFetching(false);
    }
    load();
  }, [id]);

  function setField(field: string, value: string) {
    setForm(prev => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: false }));
  }

  function err(field: string) {
    return errors[field] ? "border-red-500 focus-visible:ring-red-500" : "";
  }

  function setItem(index: number, field: keyof LineItem, value: string) {
    setLineItems(prev => prev.map((item, i) => i === index ? { ...item, [field]: value } : item));
    if (field === "name" && errors.lineItems) setErrors(prev => ({ ...prev, lineItems: false }));
  }

  function addFromCatalogue(pricingItem: any) {
    setLineItems(prev => [...prev, { name: pricingItem.name, description: pricingItem.description ?? "", quantity: "1", unit_price: String(pricingItem.unit_price) }]);
  }

  function removeItem(index: number) {
    setLineItems(prev => prev.filter((_, i) => i !== index));
  }

  const subtotal = lineItems.reduce((sum, i) => sum + (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_price) || 0), 0);
  const gst = subtotal * 0.1;
  const total = subtotal + gst;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const newErrors: Record<string, boolean> = {};
    if (!form.title.trim()) newErrors.title = true;
    if (lineItems.every(i => !i.name)) newErrors.lineItems = true;
    if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return; }
    setLoading(true);

    await supabase.from("invoices").update({
      title: form.title,
      due_date: form.due_date || null,
      notes: form.notes || null,
      work_description: form.work_description || null,
      subtotal, tax_amount: gst, total,
    }).eq("id", id);

    // Replace all line items
    await supabase.from("invoice_items").delete().eq("invoice_id", id);
    const validItems = lineItems.filter(i => i.name && i.unit_price);
    if (validItems.length > 0) {
      await supabase.from("invoice_items").insert(validItems.map(i => ({
        invoice_id: id,
        name: i.name,
        description: i.description || null,
        quantity: parseFloat(i.quantity) || 1,
        unit_price: parseFloat(i.unit_price),
      })));
    }

    toast.success("Invoice updated");
    router.push(`/dashboard/invoices/${id}`);
  }

  if (fetching) return <FormSkeleton />;

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/dashboard/invoices/${id}`}>
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500"><ArrowLeft className="w-4 h-4" />Back</Button>
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">Edit Invoice</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Invoice Details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Title *</Label>
              <Input value={form.title} onChange={e => setField("title", e.target.value)} className={err("title")} />
              {errors.title && <p className="text-xs text-red-500">Title is required</p>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Due Date</Label>
                <Input type="date" value={form.due_date} onChange={e => setField("due_date", e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description of Works</Label>
              <Textarea
                value={form.work_description}
                onChange={e => setField("work_description", e.target.value)}
                placeholder="What was carried out on-site (shown to the customer on the invoice)..."
                rows={4}
              />
              <p className="text-xs text-slate-400">Shown to the customer as &ldquo;Work Carried Out&rdquo; on the invoice.</p>
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea value={form.notes} onChange={e => setField("notes", e.target.value)} rows={2} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className={`flex flex-row items-center justify-between pb-3 ${errors.lineItems ? "border-b border-red-200" : ""}`}>
            <div>
              <CardTitle className="text-base">Line Items</CardTitle>
              {errors.lineItems && <p className="text-xs text-red-500 mt-0.5">Add at least one line item</p>}
            </div>
            <Select onValueChange={v => { const p = pricingItems.find(i => i.id === v); if (p) addFromCatalogue(p); }}>
              <SelectTrigger className="w-48 h-8 text-sm"><SelectValue placeholder="Add from catalogue" /></SelectTrigger>
              <SelectContent>{pricingItems.map(p => <SelectItem key={p.id} value={p.id}>{p.name} — ${p.unit_price}</SelectItem>)}</SelectContent>
            </Select>
          </CardHeader>
          <CardContent className="space-y-3">
            {lineItems.map((item, index) => (
              <div key={index} className="grid grid-cols-12 gap-2 items-start">
                <div className="col-span-5">
                  <Input value={item.name} onChange={e => setItem(index, "name", e.target.value)} placeholder="Item name" className="text-sm" />
                </div>
                <div className="col-span-3">
                  <Input value={item.description} onChange={e => setItem(index, "description", e.target.value)} placeholder="Description" className="text-sm" />
                </div>
                <div className="col-span-1">
                  <Input type="number" value={item.quantity} onChange={e => setItem(index, "quantity", e.target.value)} placeholder="Qty" className="text-sm" />
                </div>
                <div className="col-span-2">
                  <Input type="number" step="0.01" value={item.unit_price} onChange={e => setItem(index, "unit_price", e.target.value)} placeholder="Price" className="text-sm" />
                </div>
                <div className="col-span-1 flex justify-end pt-2">
                  <button type="button" onClick={() => removeItem(index)} className="text-slate-400 hover:text-red-500 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" className="gap-2 mt-2"
              onClick={() => setLineItems(prev => [...prev, { name: "", description: "", quantity: "1", unit_price: "" }])}>
              <Plus className="w-3.5 h-3.5" />Add Row
            </Button>

            <div className="border-t pt-3 space-y-1.5 text-sm">
              <div className="flex justify-between text-slate-600"><span>Subtotal (ex GST)</span><span>${subtotal.toFixed(2)}</span></div>
              <div className="flex justify-between text-slate-600"><span>GST (10%)</span><span>${gst.toFixed(2)}</span></div>
              <div className="flex justify-between font-bold text-slate-900 text-base border-t pt-1.5"><span>Total</span><span>${total.toFixed(2)}</span></div>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Link href={`/dashboard/invoices/${id}`}><Button variant="outline" type="button">Cancel</Button></Link>
          <Button type="submit" disabled={loading}>{loading ? "Saving..." : "Save Changes"}</Button>
        </div>
      </form>
    </div>
  );
}
