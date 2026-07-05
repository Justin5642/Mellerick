export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ArrowLeft,
  Pencil,
  Phone,
  Mail,
  Building2,
  MapPin,
  Briefcase,
  FileText,
  Receipt,
} from "lucide-react";

const jobStatusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  scheduled: "bg-blue-100 text-blue-800",
  in_progress: "bg-purple-100 text-purple-800",
  completed: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
  on_hold: "bg-gray-100 text-gray-700",
};

const quoteStatusColors: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  sent: "bg-blue-100 text-blue-700",
  accepted: "bg-green-100 text-green-700",
  declined: "bg-red-100 text-red-700",
  expired: "bg-orange-100 text-orange-700",
};

const invoiceStatusColors: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  sent: "bg-blue-100 text-blue-700",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
  cancelled: "bg-slate-100 text-slate-600",
};

function money(n: number) {
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2 })}`;
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: customer }, { data: sites }, { data: jobs }, { data: quotes }, { data: invoices }] =
    await Promise.all([
      supabase.from("customers").select("*").eq("id", id).single(),
      supabase.from("sites").select("*").eq("customer_id", id).order("name"),
      supabase.from("jobs").select("*").eq("customer_id", id).order("created_at", { ascending: false }),
      supabase.from("quotes").select("*").eq("customer_id", id).order("created_at", { ascending: false }),
      supabase.from("invoices").select("*").eq("customer_id", id).order("created_at", { ascending: false }),
    ]);

  if (!customer) notFound();

  const totalInvoiced = (invoices ?? []).reduce((sum, i: any) => sum + Number(i.total), 0);
  const totalOutstanding = (invoices ?? [])
    .filter((i: any) => i.status !== "paid" && i.status !== "cancelled")
    .reduce((sum, i: any) => sum + Number(i.total), 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <Link href="/dashboard/customers">
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
        </Link>
        <Link href={`/dashboard/customers/${id}/edit`}>
          <Button variant="outline" className="gap-2">
            <Pencil className="w-4 h-4" /> Edit
          </Button>
        </Link>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center justify-center w-14 h-14 rounded-full bg-violet-100 text-violet-700 text-lg font-bold flex-shrink-0">
          {customer.name.slice(0, 2).toUpperCase()}
        </div>
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-slate-900">{customer.name}</h1>
            <Badge variant={customer.is_active ? "default" : "secondary"}>
              {customer.is_active ? "Active" : "Inactive"}
            </Badge>
          </div>
          {customer.company && <p className="text-slate-500 text-sm">{customer.company}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-slate-500">Jobs</p>
            <p className="text-xl font-bold text-slate-900">{jobs?.length ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-slate-500">Quotes</p>
            <p className="text-xl font-bold text-slate-900">{quotes?.length ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-slate-500">Total Invoiced</p>
            <p className="text-xl font-bold text-slate-900">{money(totalInvoiced)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-slate-500">Outstanding</p>
            <p className={`text-xl font-bold ${totalOutstanding > 0 ? "text-red-600" : "text-slate-900"}`}>
              {money(totalOutstanding)}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-6 lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Contact Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {customer.phone && (
                <div className="flex items-center gap-2 text-slate-600">
                  <Phone className="w-4 h-4 text-slate-400" /> {customer.phone}
                </div>
              )}
              {customer.mobile && (
                <div className="flex items-center gap-2 text-slate-600">
                  <Phone className="w-4 h-4 text-slate-400" /> {customer.mobile} (mobile)
                </div>
              )}
              {customer.email && (
                <div className="flex items-center gap-2 text-slate-600">
                  <Mail className="w-4 h-4 text-slate-400" /> {customer.email}
                </div>
              )}
              {customer.abn && (
                <div className="flex items-center gap-2 text-slate-600">
                  <Building2 className="w-4 h-4 text-slate-400" /> ABN {customer.abn}
                </div>
              )}
              {!customer.phone && !customer.mobile && !customer.email && !customer.abn && (
                <p className="text-slate-400">No contact details on file</p>
              )}
            </CardContent>
          </Card>

          {customer.notes && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-slate-600 whitespace-pre-wrap">{customer.notes}</p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sites ({sites?.length ?? 0})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!sites || sites.length === 0 ? (
                <p className="text-sm text-slate-400">No sites added</p>
              ) : (
                sites.map((site: any) => (
                  <div key={site.id} className="flex items-start gap-2 text-sm">
                    <MapPin className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="font-medium text-slate-800">{site.name}</p>
                      <p className="text-slate-500 text-xs">
                        {site.address_line1}, {site.suburb} {site.state} {site.postcode}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2">
          <Tabs defaultValue="jobs">
            <TabsList>
              <TabsTrigger value="jobs">Jobs ({jobs?.length ?? 0})</TabsTrigger>
              <TabsTrigger value="quotes">Quotes ({quotes?.length ?? 0})</TabsTrigger>
              <TabsTrigger value="invoices">Invoices ({invoices?.length ?? 0})</TabsTrigger>
            </TabsList>

            <TabsContent value="jobs">
              <Card>
                <CardContent className="p-0">
                  {!jobs || jobs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-slate-400">
                      <Briefcase className="w-10 h-10 mb-2 opacity-40" />
                      <p className="text-sm">No jobs yet</p>
                    </div>
                  ) : (
                    <div className="divide-y">
                      {jobs.map((job: any) => (
                        <Link
                          key={job.id}
                          href={`/dashboard/jobs/${job.id}`}
                          className="flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors group"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-slate-900 group-hover:text-blue-600 truncate">
                              #{job.job_number} — {job.title}
                            </p>
                            <p className="text-xs text-slate-500">
                              {job.scheduled_start
                                ? new Date(job.scheduled_start).toLocaleDateString("en-AU")
                                : "Not scheduled"}
                            </p>
                          </div>
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize flex-shrink-0 ml-3 ${jobStatusColors[job.status] ?? ""}`}
                          >
                            {job.status?.replace("_", " ")}
                          </span>
                        </Link>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="quotes">
              <Card>
                <CardContent className="p-0">
                  {!quotes || quotes.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-slate-400">
                      <FileText className="w-10 h-10 mb-2 opacity-40" />
                      <p className="text-sm">No quotes yet</p>
                    </div>
                  ) : (
                    <div className="divide-y">
                      {quotes.map((quote: any) => (
                        <Link
                          key={quote.id}
                          href={`/dashboard/quotes/${quote.id}`}
                          className="flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors group"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-slate-900 group-hover:text-blue-600 truncate">
                              #{quote.quote_number} — {quote.title}
                            </p>
                            <p className="text-xs text-slate-500">
                              {new Date(quote.created_at).toLocaleDateString("en-AU")}
                            </p>
                          </div>
                          <div className="flex items-center gap-3 flex-shrink-0 ml-3">
                            <span className="text-sm font-semibold text-slate-700">
                              {money(Number(quote.total))}
                            </span>
                            <span
                              className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${quoteStatusColors[quote.status] ?? ""}`}
                            >
                              {quote.status}
                            </span>
                          </div>
                        </Link>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="invoices">
              <Card>
                <CardContent className="p-0">
                  {!invoices || invoices.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-slate-400">
                      <Receipt className="w-10 h-10 mb-2 opacity-40" />
                      <p className="text-sm">No invoices yet</p>
                    </div>
                  ) : (
                    <div className="divide-y">
                      {invoices.map((inv: any) => (
                        <Link
                          key={inv.id}
                          href={`/dashboard/invoices/${inv.id}`}
                          className="flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors group"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-slate-900 group-hover:text-blue-600 truncate">
                              #{inv.invoice_number} — {inv.title}
                            </p>
                            <p className="text-xs text-slate-500">
                              Due {inv.due_date ? new Date(inv.due_date).toLocaleDateString("en-AU") : "—"}
                            </p>
                          </div>
                          <div className="flex items-center gap-3 flex-shrink-0 ml-3">
                            <span className="text-sm font-semibold text-slate-700">
                              {money(Number(inv.total))}
                            </span>
                            <span
                              className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${invoiceStatusColors[inv.status] ?? ""}`}
                            >
                              {inv.status}
                            </span>
                          </div>
                        </Link>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
