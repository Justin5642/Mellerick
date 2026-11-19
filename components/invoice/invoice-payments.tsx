"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Wallet } from "lucide-react";
import { formatDate, dateKeyInBusinessTZ } from "@/lib/date";
import {
  balanceOf,
  parsePayment,
  PAYMENT_METHODS,
  paymentMethodLabel,
  paymentRecordedMessage,
  paymentStatusLabel,
} from "@/lib/invoice-payments";

export interface InvoicePayment {
  id: string;
  amount: number | string;
  paid_on: string;
  method: string;
  reference: string | null;
}

function money(n: number) {
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Payments received against an invoice, and recording a new one.
//
// Only for invoices NOT in Xero: for those, Xero is the record and the app's
// poll keeps amount_paid current (lib/xero.ts); the database refuses a manual
// payment on them (migration 0081). `payments` is null when the
// invoice_payments table does not exist (a database without 0081) — the card then
// says so rather than offering a form that cannot save.
export function InvoicePayments({
  invoiceId,
  total,
  amountPaid,
  status,
  inXero,
  payments,
}: {
  invoiceId: string;
  total: number | string | null;
  amountPaid: number | string | null;
  status: string;
  inXero: boolean;
  payments: InvoicePayment[] | null;
}) {
  const router = useRouter();
  const balance = balanceOf({ total, amount_paid: amountPaid });
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(balance > 0 ? balance.toFixed(2) : "");
  const [paidOn, setPaidOn] = useState(dateKeyInBusinessTZ(new Date()));
  const [method, setMethod] = useState<string>("bank_transfer");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);

  // Both through the office routes the phone uses (requireOfficeOrAdmin, as
  // the caller under RLS — 0081's triggers decide as before).
  async function record() {
    const parsed = parsePayment({ amount, paid_on: paidOn, method, reference });
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.payment),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "The payment could not be saved. Please try again.");
      toast.success(paymentRecordedMessage(parsed.payment.amount, balance));
      setOpen(false);
      setReference("");
      router.refresh();
    } catch (e: any) {
      toast.error(e.message ?? "The payment could not be saved. Please try again.");
    }
    setSaving(false);
  }

  async function remove(p: InvoicePayment) {
    const res = await fetch(`/api/invoices/${invoiceId}/payments/${p.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      toast.error("That payment could not be removed.");
      return;
    }
    toast.success("Payment removed");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm flex items-center gap-2"><Wallet className="w-4 h-4" />Payments</CardTitle>
        <span className={`text-sm font-semibold ${balance > 0 ? "text-amber-700" : "text-green-700"}`}>
          {paymentStatusLabel(status, balance)}
        </span>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {inXero ? (
          <p className="text-slate-500">
            This invoice is in Xero. Record payments in Xero — the app checks Xero every 30 minutes and updates this invoice
            ({money(Number(amountPaid ?? 0))} paid so far).
          </p>
        ) : payments === null ? (
          <p className="text-slate-500">Recording payments becomes available once the payments update is applied to the database.</p>
        ) : (
          <>
            {payments.length === 0 ? (
              <p className="text-slate-500">No payments recorded yet.</p>
            ) : (
              <ul className="divide-y">
                {payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="font-medium">{money(Number(p.amount))} · {paymentMethodLabel(p.method)}</p>
                      <p className="text-xs text-slate-500 truncate">
                        {formatDate(`${p.paid_on}T12:00:00`, { day: "numeric", month: "short", year: "numeric" })}
                        {p.reference ? ` · ${p.reference}` : ""}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-slate-400 hover:text-red-600" onClick={() => remove(p)} aria-label="Remove payment">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {status !== "draft" && balance > 0 && !open && (
              <Button size="sm" className="gap-2" onClick={() => { setAmount(balance.toFixed(2)); setOpen(true); }}>
                <Wallet className="w-4 h-4" />Record payment
              </Button>
            )}

            {open && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="pay-amount">Amount received</Label>
                    <Input id="pay-amount" type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="pay-date">Date received</Label>
                    <Input id="pay-date" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>Method</Label>
                    <Select value={method} onValueChange={(v) => setMethod(v ?? "bank_transfer")}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PAYMENT_METHODS.map((m) => (
                          <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="pay-ref">Reference (optional)</Label>
                    <Input id="pay-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. bank ref" />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
                  <Button size="sm" onClick={record} disabled={saving}>{saving ? "Saving..." : "Save payment"}</Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
