"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Send, CheckCircle2, ExternalLink, Pencil } from "lucide-react";
import Link from "next/link";

const statusColors: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  sent: "bg-blue-100 text-blue-700",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
  cancelled: "bg-slate-100 text-slate-600",
};

interface Props {
  invoice: any;
  xeroConnected: boolean;
}

export function InvoiceDetail({ invoice, xeroConnected }: Props) {
  const [pushing, setPushing] = useState(false);
  const [pushed, setPushed] = useState(!!invoice.xero_invoice_id);

  async function pushToXero() {
    setPushing(true);
    try {
      const res = await fetch("/api/xero/push-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceId: invoice.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success("Invoice pushed to Xero successfully");
      setPushed(true);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to push to Xero");
    }
    setPushing(false);
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/invoices">
            <Button variant="ghost" size="sm" className="gap-2 text-slate-500"><ArrowLeft className="w-4 h-4" />Back</Button>
          </Link>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-slate-900">#{invoice.invoice_number} — {invoice.title}</h1>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${statusColors[invoice.status]}`}>{invoice.status}</span>
            </div>
            <p className="text-sm text-slate-500 mt-0.5">{invoice.customers?.name}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link href={`/dashboard/invoices/${invoice.id}/edit`}>
            <Button variant="outline" size="sm" className="gap-2"><Pencil className="w-3.5 h-3.5" />Edit</Button>
          </Link>
          {pushed ? (
            <span className="flex items-center gap-1.5 text-sm text-green-700 font-medium">
              <CheckCircle2 className="w-4 h-4" /> In Xero
            </span>
          ) : xeroConnected ? (
            <Button onClick={pushToXero} disabled={pushing} className="gap-2 bg-blue-600 hover:bg-blue-700">
              <Send className="w-4 h-4" />
              {pushing ? "Pushing to Xero..." : "Push to Xero"}
            </Button>
          ) : (
            <Link href="/dashboard/settings">
              <Button variant="outline" size="sm" className="gap-2">
                <ExternalLink className="w-3.5 h-3.5" /> Connect Xero first
              </Button>
            </Link>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">Customer</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <p className="font-medium">{invoice.customers?.name}</p>
            {invoice.customers?.email && <p className="text-slate-500">{invoice.customers.email}</p>}
            {invoice.customers?.phone && <p className="text-slate-500">{invoice.customers.phone}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Details</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="flex justify-between"><span className="text-slate-500">Created</span><span>{new Date(invoice.created_at).toLocaleDateString("en-AU")}</span></div>
            {invoice.due_date && <div className="flex justify-between"><span className="text-slate-500">Due</span><span>{new Date(invoice.due_date).toLocaleDateString("en-AU")}</span></div>}
            {invoice.xero_invoice_id && <div className="flex justify-between"><span className="text-slate-500">Xero ID</span><span className="text-xs font-mono truncate ml-2">{invoice.xero_invoice_id}</span></div>}
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
              {invoice.invoice_items?.map((item: any) => (
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
            <div className="flex justify-between text-slate-600"><span>Subtotal (ex GST)</span><span>${Number(invoice.subtotal).toFixed(2)}</span></div>
            <div className="flex justify-between text-slate-600"><span>GST (10%)</span><span>${Number(invoice.tax_amount).toFixed(2)}</span></div>
            <div className="flex justify-between font-bold text-slate-900 text-base border-t pt-1.5"><span>Total</span><span>${Number(invoice.total).toFixed(2)}</span></div>
          </div>
        </CardContent>
      </Card>

      {invoice.notes && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Notes</CardTitle></CardHeader>
          <CardContent><p className="text-sm text-slate-600">{invoice.notes}</p></CardContent>
        </Card>
      )}
    </div>
  );
}
