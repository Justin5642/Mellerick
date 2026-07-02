export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Receipt, Plus, AlertCircle } from "lucide-react";
import Link from "next/link";

const statusColors: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  sent: "bg-blue-100 text-blue-700",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
  cancelled: "bg-slate-100 text-slate-600",
};

export default async function InvoicesPage() {
  const supabase = await createClient();
  const [{ data: invoices }, { data: readyJobs }] = await Promise.all([
    supabase.from("invoices").select("*, customers(name)").order("created_at", { ascending: false }),
    supabase.from("jobs").select("id, job_number, title, customer_id, customers(name)").eq("ready_to_invoice", true).order("updated_at", { ascending: false }),
  ]);

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

      {/* Ready to Invoice queue */}
      {readyJobs && readyJobs.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/50">
          <div className="flex items-center gap-2 px-6 py-4 border-b border-amber-100">
            <AlertCircle className="w-4 h-4 text-amber-600" />
            <h2 className="text-sm font-semibold text-amber-800">Ready to Invoice ({readyJobs.length})</h2>
          </div>
          <CardContent className="p-0">
            <div className="divide-y divide-amber-100">
              {readyJobs.map((job: any) => (
                <div key={job.id} className="flex items-center justify-between px-6 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-800">#{job.job_number} — {job.title}</p>
                    <p className="text-xs text-slate-500">{job.customers?.name}</p>
                  </div>
                  <Link href={`/dashboard/invoices/new?job_id=${job.id}&customer_id=${job.customer_id}&title=${encodeURIComponent(job.title)}`}>
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
                      #{inv.invoice_number} — {inv.title}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {inv.customers?.name} · Due {inv.due_date ? new Date(inv.due_date).toLocaleDateString("en-AU") : "—"}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                    <span className="text-sm font-semibold text-slate-700">${Number(inv.total).toLocaleString("en-AU", { minimumFractionDigits: 2 })}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${statusColors[inv.status]}`}>{inv.status}</span>
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
