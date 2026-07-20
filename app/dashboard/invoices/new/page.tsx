"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Plus, Trash2, GitPullRequestArrow } from "lucide-react";
import Link from "next/link";
import { CustomerPicker } from "@/components/customer-picker";

interface LineItem { name: string; description: string; quantity: string; unit_price: string; variationId?: string; }
interface JobOption {
  id: string;
  job_number: number;
  title: string;
  status: string;
  customer_id: string;
  customers?: { name: string } | null;
  sites?: { address_line1: string; suburb: string } | null;
}
function jobLabel(j: JobOption) {
  return `#${j.job_number} — ${j.title}`;
}
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
  // useSearchParams() needs a Suspense boundary above it in the App Router.
  return (
    <Suspense fallback={null}>
      <NewInvoiceForm />
    </Suspense>
  );
}

function NewInvoiceForm() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [pricingItems, setPricingItems] = useState<any[]>([]);
  const [allJobs, setAllJobs] = useState<JobOption[]>([]);
  const [jobQuery, setJobQuery] = useState("");
  const [showJobResults, setShowJobResults] = useState(false);
  const [titleTouched, setTitleTouched] = useState(false);
  // Once the office edits the description of works, stop auto-overwriting it
  // from the linked job (mirrors titleTouched).
  const [workDescTouched, setWorkDescTouched] = useState(false);

  // Reactive, unlike reading window.location.search once: the App Router
  // can navigate from /dashboard/invoices/new?job_id=A to ?job_id=B without
  // remounting this component (same route, only the query string changed),
  // so a mount-only read would keep showing whatever the *first* visit's
  // params were — e.g. blank, if "+ New Invoice" was opened earlier in the
  // session. useSearchParams() plus the effect below keep it in sync on
  // every navigation, not just the first.
  const searchParams = useSearchParams();
  const jobIdParam = searchParams.get("job_id");
  const customerIdParam = searchParams.get("customer_id");
  const titleParam = searchParams.get("title");

  const [form, setForm] = useState({
    title: titleParam ?? "",
    customer_id: customerIdParam ?? "",
    job_id: jobIdParam ?? "",
    due_date: "",
    notes: "",
    work_description: "",
  });
  const [lineItems, setLineItems] = useState<LineItem[]>([{ name: "", description: "", quantity: "1", unit_price: "" }]);
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [unbilledVariations, setUnbilledVariations] = useState<UnbilledVariation[]>([]);
  const addedVariationIds = lineItems.filter((i) => i.variationId).map((i) => i.variationId as string);

  const jobSelectFields = "id, job_number, title, status, customer_id, customers(name), sites(address_line1, suburb)";

  useEffect(() => {
    async function load() {
      const [{ data: p }, { data: j }] = await Promise.all([
        supabase.from("pricing_items").select("*").eq("is_active", true).order("name"),
        // Loaded once for the job search box below — deliberately not filtered
        // by status or customer, since a job needing a top-up invoice for a
        // late-approved variation might not be "completed", and letting people
        // search by address/customer means they shouldn't have to pick the
        // customer first just to narrow the job list.
        supabase.from("jobs").select(jobSelectFields).neq("status", "cancelled").order("updated_at", { ascending: false }).limit(500),
      ]);
      setPricingItems(p ?? []);
      setAllJobs((j as any) ?? []);
    }
    load();
  }, []);

  useEffect(() => {
    // Keeps form fields synced to the URL's job_id/customer_id/title any time
    // they change — including when this exact component instance was already
    // mounted (e.g. "+ New Invoice" was opened earlier this session) and the
    // App Router just swapped the query string rather than remounting the
    // page. Without this, the form would silently keep showing whatever the
    // *first* visit's params were.
    if (jobIdParam || customerIdParam || titleParam) {
      setTitleTouched(false);
      setForm((prev) => ({
        ...prev,
        job_id: jobIdParam ?? prev.job_id,
        customer_id: customerIdParam ?? prev.customer_id,
        title: titleParam ?? prev.title,
      }));
    }
  }, [jobIdParam, customerIdParam, titleParam]);

  useEffect(() => {
    // Arrived here from the "Ready to Invoice" queue with a job_id in the
    // URL. Fetch that exact job directly (no status/customer filter) so the
    // search box shows it pre-selected even if it isn't in the bulk list
    // below yet, or isn't "completed" — nothing here should require retyping
    // what the queue already knew. Re-runs whenever job_id changes, not just
    // on mount, for the same reason as the effect above.
    async function loadLinkedJob() {
      if (!jobIdParam) { setJobQuery(""); return; }
      const { data } = await supabase.from("jobs").select(jobSelectFields).eq("id", jobIdParam).single();
      if (data) {
        setJobQuery(jobLabel(data as any));
        setAllJobs((prev) => (prev.some((j) => j.id === (data as any).id) ? prev : [data as any, ...prev]));
      }
    }
    loadLinkedJob();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobIdParam]);

  const jobMatches = useMemo(() => {
    const q = jobQuery.trim().toLowerCase();
    if (!q) return [];
    const tokens = q.split(/\s+/);
    return allJobs
      .filter((j) => {
        const haystack = `${j.job_number} ${j.title} ${j.customers?.name ?? ""} ${j.sites?.address_line1 ?? ""} ${j.sites?.suburb ?? ""}`.toLowerCase();
        return tokens.every((t) => haystack.includes(t));
      })
      .slice(0, 8);
  }, [jobQuery, allJobs]);

  function selectJob(j: JobOption) {
    setForm((prev) => ({
      ...prev,
      job_id: j.id,
      customer_id: j.customer_id,
      title: titleTouched ? prev.title : j.title || prev.title,
    }));
    setJobQuery(jobLabel(j));
    setShowJobResults(false);
    setErrors((prev) => ({ ...prev, customer_id: false }));
  }

  function clearJob() {
    setForm((prev) => ({ ...prev, job_id: "" }));
    setJobQuery("");
  }

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

  useEffect(() => {
    // Pre-fill "Description of Works" from the linked job's on-site record so
    // the office starts from what the technician actually wrote rather than a
    // blank box: prefer the typed completion notes, fall back to the Whisper
    // voice-report transcript. Stops once the office has edited the field
    // (workDescTouched) so a re-selected job can't clobber their wording.
    async function prefillWorkDescription() {
      if (workDescTouched) return;
      if (!form.job_id) {
        setForm((prev) => (prev.work_description ? { ...prev, work_description: "" } : prev));
        return;
      }
      const { data } = await supabase
        .from("jobs")
        .select("completion_notes, voice_report_transcript")
        .eq("id", form.job_id)
        .single();
      const desc = (data?.completion_notes || data?.voice_report_transcript || "").trim();
      setForm((prev) => ({ ...prev, work_description: desc }));
    }
    prefillWorkDescription();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  function setCustomer(value: string) {
    setField("customer_id", value);
    // Manually changing the customer away from the linked job's customer
    // would leave a mismatched pairing — clear the job selection instead of
    // silently keeping a stale link.
    const linkedJob = allJobs.find(j => j.id === form.job_id);
    if (linkedJob && linkedJob.customer_id !== value) {
      clearJob();
    }
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
              <Label>Linked Job</Label>
              <div className="relative">
                <Input
                  value={jobQuery}
                  onChange={e => {
                    setJobQuery(e.target.value);
                    setShowJobResults(true);
                    if (form.job_id) setForm(prev => ({ ...prev, job_id: "" }));
                  }}
                  onFocus={() => setShowJobResults(true)}
                  onBlur={() => setTimeout(() => setShowJobResults(false), 150)}
                  placeholder="Search by job number, title, customer or address..."
                  className={form.job_id ? "pr-14" : ""}
                />
                {form.job_id && (
                  <button
                    type="button"
                    onClick={clearJob}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-red-500"
                  >
                    Clear
                  </button>
                )}
                {showJobResults && jobQuery.trim().length > 0 && (
                  <div className="absolute z-10 mt-1 w-full bg-white border rounded-md shadow-lg max-h-64 overflow-y-auto">
                    {jobMatches.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-slate-400">No jobs match &ldquo;{jobQuery}&rdquo;</p>
                    ) : (
                      jobMatches.map(j => (
                        <button
                          key={j.id}
                          type="button"
                          onClick={() => selectJob(j)}
                          className="w-full text-left px-3 py-2 hover:bg-slate-50 border-b last:border-0"
                        >
                          <p className="text-sm font-medium text-slate-800 truncate">{jobLabel(j)}</p>
                          <p className="text-xs text-slate-500 truncate">
                            {j.customers?.name}
                            {j.sites ? ` · ${j.sites.address_line1}, ${j.sites.suburb}` : ""}
                          </p>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              <p className="text-xs text-slate-400">Picking a job fills in the customer and title below automatically.</p>
            </div>
            <div className="space-y-2">
              <Label>Title *</Label>
              <Input
                value={form.title}
                onChange={e => { setTitleTouched(true); setField("title", e.target.value); }}
                placeholder="e.g. Bathroom renovation — 123 Main St"
                className={err("title")}
              />
              {errors.title && <p className="text-xs text-red-500">Title is required</p>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Customer *</Label>
                <CustomerPicker
                  value={form.customer_id}
                  onChange={v => setCustomer(v)}
                  placeholder="Search customers..."
                  error={errors.customer_id}
                />
                {errors.customer_id && <p className="text-xs text-red-500">Customer is required</p>}
              </div>
              <div className="space-y-2">
                <Label>Due Date</Label>
                <Input type="date" value={form.due_date} onChange={e => setField("due_date", e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description of Works</Label>
              <Textarea
                value={form.work_description}
                onChange={e => { setWorkDescTouched(true); setField("work_description", e.target.value); }}
                placeholder="What was carried out on-site (shown to the customer on the invoice)..."
                rows={4}
              />
              <p className="text-xs text-slate-400">Pre-filled from the linked job&rsquo;s completion notes. Review before sending — this appears on the customer&rsquo;s invoice.</p>
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
