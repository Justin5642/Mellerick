export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, AlertCircle } from "lucide-react";
import Link from "next/link";
import { InvoiceList } from "@/components/invoice/invoice-list";
import { INVOICE_LIST_COLUMNS, INVOICE_PAGE_SIZE, type InvoiceListRow } from "@/lib/invoice-list";

export default async function InvoicesPage() {
  const supabase = await createClient();
  const [{ data: invoices, count: invoiceCount }, { data: readyJobs }, { data: unbilledVariations }] = await Promise.all([
    // First page only, with the total for the header. Every invoice with every
    // column used to load here; the rest now come 50 at a time via Load more
    // (components/invoice/invoice-list.tsx, same columns and order).
    supabase
      .from("invoices")
      .select(INVOICE_LIST_COLUMNS, { count: "exact" })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(0, INVOICE_PAGE_SIZE - 1),
    supabase.from("jobs").select("id, job_number, title, customer_id, customers(name)").eq("ready_to_invoice", true).order("updated_at", { ascending: false }),
    // Catches the case ready_to_invoice can't: a job that already got its
    // first invoice, then had a variation approved later. Nothing else
    // resets ready_to_invoice back to true for that, so without this
    // separate query it would silently never surface anywhere.
    supabase
      .from("job_variations")
      .select("id, total_amount, jobs(id, job_number, title, customer_id, customers(name))")
      .in("status", ["approved", "auto_approved"])
      .is("invoice_id", null),
  ]);

  // Merge both sources into one queue, keyed by job, so a job needing its
  // very first invoice and a job with a leftover unbilled variation both
  // show up in the same place with no risk of falling through the cracks.
  const queue = new Map<string, any>();
  for (const job of readyJobs ?? []) {
    queue.set(job.id, { ...job, needsFirstInvoice: true, variationsTotal: 0, variationsCount: 0 });
  }
  for (const v of unbilledVariations ?? []) {
    const job = (v as any).jobs;
    if (!job) continue;
    const existing = queue.get(job.id) ?? { ...job, needsFirstInvoice: false, variationsTotal: 0, variationsCount: 0 };
    existing.variationsTotal += Number(v.total_amount) || 0;
    existing.variationsCount += 1;
    queue.set(job.id, existing);
  }
  const totalInvoices = invoiceCount ?? invoices?.length ?? 0;
  const invoiceQueue = Array.from(queue.values()).sort((a, b) => (b.needsFirstInvoice ? 1 : 0) - (a.needsFirstInvoice ? 1 : 0));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Invoices</h1>
          <p className="text-slate-500 text-sm mt-1">{totalInvoices} total invoices</p>
        </div>
        <Link href="/dashboard/invoices/new">
          <Button className="gap-2"><Plus className="w-4 h-4" />New Invoice</Button>
        </Link>
      </div>

      {/* Ready to Invoice queue — every job that either never got an
          invoice, or has an approved variation still sitting unbilled,
          lands here so nothing gets missed. */}
      {invoiceQueue.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/50">
          <div className="flex items-center gap-2 px-6 py-4 border-b border-amber-100">
            <AlertCircle className="w-4 h-4 text-amber-600" />
            <h2 className="text-sm font-semibold text-amber-800">Ready to Invoice ({invoiceQueue.length})</h2>
          </div>
          <CardContent className="p-0">
            <div className="divide-y divide-amber-100">
              {invoiceQueue.map((job: any) => (
                <div key={job.id} className="flex items-center justify-between px-6 py-3 gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">#{job.job_number} — {job.title}</p>
                    <p className="text-xs text-slate-500">{job.customers?.name}</p>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      {job.needsFirstInvoice && (
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">No invoice yet</span>
                      )}
                      {job.variationsCount > 0 && (
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                          {job.variationsCount} unbilled variation{job.variationsCount === 1 ? "" : "s"} · ${job.variationsTotal.toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>
                  <Link href={`/dashboard/invoices/new?job_id=${job.id}&customer_id=${job.customer_id}&title=${encodeURIComponent(job.title)}`} className="shrink-0">
                    <Button size="sm" className="gap-1.5 h-8 text-xs">
                      <Plus className="w-3.5 h-3.5" />Create Invoice
                    </Button>
                  </Link>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <InvoiceList initialInvoices={(invoices ?? []) as InvoiceListRow[]} total={totalInvoices} />
    </div>
  );
}
