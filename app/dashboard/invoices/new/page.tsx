"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Plus, Trash2, GitPullRequestArrow } from "lucide-react";
import Link from "next/link";

interface LineItem { name: string; description: string; quantity: string; unit_price: string; variationId?: string; }
interface UnbilledVariation {
  id: string;
  custom_name: string | null;
  quantity: number;
  unit: string;
  rate: number | null;
  total_amount: number | null;
  variation_types?: { name: string } | null;
}

export default function NewInvoicePage() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [pricingItems, setPricingItems] = useState<any[]>([]);

  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const [form, setForm] = useState({
    title: params?.get("title") ?? "",
    customer_id: params?.get("customer_id") ?? "",
    job_id: params?.get("job_id") ?? "",
    due_date: "",
    notes: "",
  });
  const [lineItems, setLineItems] = useState<LineItem[]>([{ name: "", description: "", quantity: "1", unit_price: "" }]);
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [unbilledVariations, setUnbilledVariations] = useState<UnbilledVariation[]>([]);
  const addedVariationIds = lineItems.filter((i) => i.variationId).map((i) => i.variationId as string);

  useEffect(() => {
    async function load() {
      const [{ data: c }, { data: p }] = await Promise.all([
        supabase.from("customers").select("id, name").eq("is_active", true).order("name"),
        supabase.from("pricing_items").select("*").eq("is_active", true).order("name"),
      ]);
      setCustomers(c ?? []);
      setPricingItems(p ?? []);
    }
    load();
  }, []);

  useEffect(() => {
    async function loadJobs() {
      if (!form.customer_id) { setJobs([]); return; }
      const { data } = await supabase.from("jobs").select("id, job_number, title").eq("customer_id", form.customer_id).eq("status", "completed");
      setJobs(data ?? []);
    }
    loadJobs();
  }, [form.customer_id]);

  useEffect(() => {
    async function loadUnbilledVariations() {
      if (!form.job_id) { setUnbilledVariations([]); return; }
      const { data } = await supabase
        .from("job_variations")
        .select("id, custom_name, quantity, unit, rate, total_amount, variation_types(name)")
        .eq("job_id", form.job_id)
        .in("status", ["approved", "auto_approved"])
        .is("invoice_id", null);
      setUnbilledVariations((data as any) ?? []);
    }
    loadUnbilledVariations();
  }, [form.job_id]);

  function addVariationToInvoice(v: UnbilledVariation) {
    setLineItems((prev) => {
      const withoutBlankFirst = prev.length === 1 && !prev[0].name && !prev[0].unit_price ? [] : prev;
      return [
        ...withoutBlankFirst,
        {
          name: v.variation_types?.name ?? v.custom_name ?? "Variation",
          description: `${v.quantity} ${v.unit}${v.rate != null ? ` @ $${Number(v.rate).toFixed(2)}` : ""}`,
          quantity: "1",
          unit_price: String(v.total_amount ?? (Number(v.rate ?? 0) * Number(v.quantity))),
          variationId: v.id,
        },
      ];
    });
  }


  function setField(field: string, value: string | null) {
    setForm(prev => ({ ...prev, [field]: value ?? "" }));
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
    if (!form.customer_id) newErrors.customer_id = true;
    if (lineItems.every(i => !i.name)) newErrors.lineItems = true;
    if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return; }
    setLoading(true);
    const { data: invoice, error } = await supabase.from("invoices").insert({
      ...form,
      job_id: form.job_id || null,
      due_date: form.due_date || null,
      subtotal, tax_amount: gst, total,
      status: "draft",
    }).select().single();

    if (error || !invoice) { toast.error(error?.message ?? "Failed to create invoice"); setLoading(false); return; }

    const validItems = lineItems.filter(i => i.name && i.unit_price);
    if (validItems.length > 0) {
      await supabase.from("invoice_items").insert(validItems.map(i => ({
        invoice_id: invoice.id,
        name: i.name,
        description: i.description || null,
        quantity: parseFloat(i.quantity) || 1,
        unit_price: parseFloat(i.unit_price),
      })));
    }

    // Mark any variations that were pulled onto this invoice as billed, so
    // they drop off the "unbilled" warning and can't be double-invoiced.
    const includedVariationIds = validItems.filter(i => i.variationId).map(i => i.variationId as string);
    if (includedVariationIds.length > 0) {
      await supabase.from("job_variations").update({ invoice_id: invoice.id }).in("id", includedVariationIds);
    }

    if (form.job_id) {
      await supabase.from("jobs").update({ ready_to_invoice: false }).eq("id", form.job_id);
    }

    toast.success("Invoice created");
    router.refresh();
    router.push(`/dashboard/invoices/${invoice.id}`);
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/invoices">
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500"><ArrowLeft className="w-4 h-4" />Back</Button>
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">New Invoice</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Invoice Details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Title *</Label>
              <Input value={form.title} onChange={e => setField("title", e.target.value)} placeholder="e.g. Bathroom renovation — 123 Main St" className={err("title")} />
              {errors.title && <p className="text-xs text-red-500">Title is required</p>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Customer *</Label>
                <Select value={form.customer_id} onValueChange={v => setField("customer_id", v as string)}>
                  <SelectTrigger className={err("customer_id")}><SelectValue placeholder="Select customer" /></SelectTrigger>
                  <SelectContent>{customers.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                </Select>
                {errors.customer_id && <p className="text-xs text-red-500">Customer is required</p>}
              </div>
              <div className="space-y-2">
                <Label>Linked Job</Label>
                <Select value={form.job_id} onValueChange={v => setField("job_id", v as string)} disabled={!form.customer_id}>
                  <SelectTrigger><SelectValue placeholder="Select completed job" /></SelectTrigger>
                  <SelectContent>{jobs.map(j => <SelectItem key={j.id} value={j.id}>#{j.job_number} — {j.title}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Due Date</Label>
                <Input type="date" value={form.due_date} onChange={e => setField("due_date", e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea value={form.notes} onChange={e => setField("notes", e.target.value)} placeholder="Payment terms, notes..." rows={2} />
            </div>
          </CardContent>
        </Card>

        {unbilledVariations.filter(v => !addedVariationIds.includes(v.id)).length > 0 && (
          <Card className="border-orange-200 bg-orange-50/40">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 text-orange-800">
                <GitPullRequestArrow className="w-4 h-4" />
                Unbilled variations on this job
              </CardTitle>
              <p className="text-xs text-orange-700/80">Approved extra work not yet on an invoice — add it now so it doesn't get missed.</p>
            </CardHeader>
            <CardContent className="space-y-2">
              {unbilledVariations.filter(v => !addedVariationIds.includes(v.id)).map(v => (
                <div key={v.id} className="flex items-center justify-between gap-3 bg-white rounded-md border px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{v.variation_types?.name ?? v.custom_name}</p>
                    <p className="text-xs text-slate-500">
                      {v.quantity} {v.unit}{v.rate != null ? ` × $${Number(v.rate).toFixed(2)}` : ""} = ${Number(v.total_amount ?? 0).toFixed(2)}
                    </p>
                  </div>
                  <Button type="button" size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={() => addVariationToInvoice(v)}>
                    <Plus className="w-3.5 h-3.5" />Add to invoice
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <Card className={errors.lineItems ? "border-red-400" : ""}>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
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
          <Link href="/dashboard/invoices"><Button variant="outline" type="button">Cancel</Button></Link>
          <Button type="submit" disabled={loading}>{loading ? "Saving..." : "Create Invoice"}</Button>
        </div>
      </form>
    </div>
  );
}
