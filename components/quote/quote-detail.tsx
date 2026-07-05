"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Send, CheckCircle2, XCircle, Pencil, Briefcase } from "lucide-react";
import Link from "next/link";

const statusColors: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  sent: "bg-blue-100 text-blue-700",
  accepted: "bg-green-100 text-green-700",
  declined: "bg-red-100 text-red-700",
  expired: "bg-orange-100 text-orange-700",
};

interface Props {
  quote: any;
}

export function QuoteDetail({ quote }: Props) {
  const router = useRouter();
  const supabase = createClient();
  const [status, setStatus] = useState(quote.status);
  const [updating, setUpdating] = useState(false);
  const [converting, setConverting] = useState(false);
  const [converted, setConverted] = useState(!!quote.job_id);

  async function updateStatus(newStatus: string) {
    setUpdating(true);
    const { error } = await supabase.from("quotes").update({ status: newStatus }).eq("id", quote.id);
    if (error) {
      toast.error(error.message);
    } else {
      setStatus(newStatus);
      toast.success(`Quote marked as ${newStatus}`);
      router.refresh();
    }
    setUpdating(false);
  }

  async function convertToJob() {
    setConverting(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data: job, error } = await supabase
      .from("jobs")
      .insert({
        title: quote.title,
        description: quote.notes || null,
        customer_id: quote.customer_id,
        site_id: quote.site_id || null,
        job_type: "service",
        status: "pending",
        created_by: user?.id,
      })
      .select()
      .single();

    if (error || !job) {
      toast.error(error?.message ?? "Failed to create job");
      setConverting(false);
      return;
    }

    const items = quote.quote_items ?? [];
    if (items.length > 0) {
      await supabase.from("job_items").insert(
        items.map((i: any) => ({
          job_id: job.id,
          name: i.name,
          description: i.description,
          quantity: i.quantity,
          unit_price: i.unit_price,
        }))
      );
    }

    await supabase.from("quotes").update({ job_id: job.id }).eq("id", quote.id);

    toast.success("Job created from quote");
    setConverted(true);
    router.push(`/dashboard/jobs/${job.id}`);
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/quotes">
            <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
              <ArrowLeft className="w-4 h-4" />Back
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-slate-900">#{quote.quote_number} — {quote.title}</h1>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${statusColors[status] ?? ""}`}>{status}</span>
            </div>
            <p className="text-sm text-slate-500 mt-0.5">{quote.customers?.name}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Link href={`/dashboard/quotes/${quote.id}/edit`}>
            <Button variant="outline" size="sm" className="gap-2"><Pencil className="w-3.5 h-3.5" />Edit</Button>
          </Link>

          {status === "draft" && (
            <Button onClick={() => updateStatus("sent")} disabled={updating} className="gap-2 bg-blue-600 hover:bg-blue-700">
              <Send className="w-4 h-4" />
              {updating ? "Updating..." : "Mark as Sent"}
            </Button>
          )}

          {status === "sent" && (
            <>
              <Button onClick={() => updateStatus("declined")} disabled={updating} variant="outline" className="gap-2 text-red-600 hover:text-red-700">
                <XCircle className="w-4 h-4" />Declined
              </Button>
              <Button onClick={() => updateStatus("accepted")} disabled={updating} className="gap-2 bg-green-600 hover:bg-green-700">
                <CheckCircle2 className="w-4 h-4" />Accepted
              </Button>
            </>
          )}

          {status === "accepted" && (
            converted ? (
              <span className="flex items-center gap-1.5 text-sm text-green-700 font-medium">
                <CheckCircle2 className="w-4 h-4" /> Converted to Job
              </span>
            ) : (
              <Button onClick={convertToJob} disabled={converting} className="gap-2 bg-slate-900 hover:bg-slate-800">
                <Briefcase className="w-4 h-4" />
                {converting ? "Creating job..." : "Convert to Job"}
              </Button>
            )
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">Customer</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <p className="font-medium">{quote.customers?.name}</p>
            {quote.customers?.email && <p className="text-slate-500">{quote.customers.email}</p>}
            {quote.customers?.phone && <p className="text-slate-500">{quote.customers.phone}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Details</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="flex justify-between"><span className="text-slate-500">Created</span><span>{new Date(quote.created_at).toLocaleDateString("en-AU")}</span></div>
            {quote.valid_until && <div className="flex justify-between"><span className="text-slate-500">Valid Until</span><span>{new Date(quote.valid_until).toLocaleDateString("en-AU")}</span></div>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-slate-50">
                <th className="text-left px-4 py-3 font-medium text-slate-500">Item</th>
                <th className="text-right px-4 py-3 font-medium text-slate-500 w-16">Qty</th>
                <th className="text-right px-4 py-3 font-medium text-slate-500 w-24">Unit Price</th>
                <th className="text-right px-4 py-3 font-medium text-slate-500 w-24">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {quote.quote_items?.map((item: any) => (
                <tr key={item.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium">{item.name}</p>
                    {item.description && <p className="text-xs text-slate-500">{item.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-700">{item.quantity}</td>
                  <td className="px-4 py-3 text-right text-slate-700">${Number(item.unit_price).toFixed(2)}</td>
                  <td className="px-4 py-3 text-right font-medium">${Number(item.total).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t px-4 py-3 space-y-1.5 bg-slate-50 text-sm">
            <div className="flex justify-between text-slate-600"><span>Subtotal (ex GST)</span><span>${Number(quote.subtotal).toFixed(2)}</span></div>
            <div className="flex justify-between text-slate-600"><span>GST (10%)</span><span>${Number(quote.tax_amount).toFixed(2)}</span></div>
            <div className="flex justify-between font-bold text-slate-900 text-base border-t pt-1.5"><span>Total</span><span>${Number(quote.total).toFixed(2)}</span></div>
          </div>
        </CardContent>
      </Card>

      {quote.notes && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Notes</CardTitle></CardHeader>
          <CardContent><p className="text-sm text-slate-600 whitespace-pre-wrap">{quote.notes}</p></CardContent>
        </Card>
      )}
    </div>
  );
}
