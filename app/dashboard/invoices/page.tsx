export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Receipt, Plus, AlertCircle } from "lucide-react";
import Link from "next/link";
import { formatDate } from "@/lib/date";
import { formatInvoiceNumber } from "@/lib/utils";
import { invoiceStatusColors } from "@/lib/badge-colors";

export default async function InvoicesPage() {
  const supabase = await createClient();
  const [{ data: invoices }, { data: readyJobs }, { data: unbilledVariations }] = await Promise.all([
    supabase.from("invoices").select("*, customers(name)").order("created_at", { ascending: false }),
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
  const invoiceQueue = Array.from(queue.values()).sort((a, b) => (b.needsFirstInvoice ? 1 : 0) - (a.needsFirstInvoice ? 1 : 0));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Invoices</h1>
          <p className="text-slate-500 text-sm mt-1">{invoices?.length ?? 0} total invoices</p>
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

      <Card>
        <CardContent className="p-0">
          {!invoices || invoices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <Receipt className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm font-medium">No invoices yet</p>
              <Link href="/dashboard/invoices/new" className="mt-2 text-sm text-blue-600 hover:underline">Create your first invoice</Link>
            </div>
          ) : (
            <div className="divide-y">
              {invoices.map((inv: any) => (
                <Link key={inv.id} href={`/dashboard/invoices/${inv.id}`} className="flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition-colors group">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm group-hover:text-blue-600 transition-colors truncate">
                      {formatInvoiceNumber(inv.invoice_number)} — {inv.title}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {inv.customers?.name} · Due {inv.due_date ? formatDate(inv.due_date) : "—"}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                    <span className="text-sm font-semibold text-slate-700">${Number(inv.total).toLocaleString("en-AU", { minimumFractionDigits: 2 })}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${invoiceStatusColors[inv.status]}`}>{inv.status}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
