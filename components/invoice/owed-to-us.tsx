"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { OwedSummary } from "@/lib/invoice-payments";

function money(n: number) {
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const BUCKET_TONE: Record<string, string> = {
  current: "text-slate-700",
  "1-30": "text-amber-700",
  "31-60": "text-orange-700",
  "61-90": "text-red-700",
  "90+": "text-red-800",
};

// "What's owed to us": every sent or overdue invoice with a balance, grouped
// by how late it is — the chasing list. Balances, not invoice totals, so a
// part-paid invoice counts only what is still owing (lib/invoice-payments.ts).
export function OwedToUs({ summary }: { summary: OwedSummary }) {
  // Overdue groups start open; "not yet due" starts closed.
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(summary.buckets.filter((b) => b.key !== "current" && b.invoices.length > 0).map((b) => b.key))
  );
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (summary.count === 0) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-slate-500">Nothing owed — every sent invoice is paid.</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Owed to us</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-md bg-slate-50 p-3">
            <p className="text-xs text-slate-500">Outstanding</p>
            <p className="text-xl font-semibold tabular-nums">{money(summary.outstanding)}</p>
            <p className="text-xs text-slate-500">{summary.count} invoice{summary.count === 1 ? "" : "s"}</p>
          </div>
          <div className="rounded-md bg-red-50 p-3">
            <p className="text-xs text-red-700">Overdue</p>
            <p className="text-xl font-semibold tabular-nums text-red-700">{money(summary.overdue)}</p>
          </div>
          <div className="rounded-md bg-slate-50 p-3">
            <p className="text-xs text-slate-500">Not yet due</p>
            <p className="text-xl font-semibold tabular-nums">{money(Math.max(0, summary.outstanding - summary.overdue))}</p>
          </div>
        </div>

        <div className="divide-y rounded-md border">
          {summary.buckets
            .filter((b) => b.invoices.length > 0)
            .map((b) => (
              <div key={b.key}>
                <button
                  type="button"
                  onClick={() => toggle(b.key)}
                  className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-slate-50"
                  aria-expanded={open.has(b.key)}
                >
                  <span className={`flex items-center gap-1.5 font-medium ${BUCKET_TONE[b.key]}`}>
                    {open.has(b.key) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    {b.label}
                    <span className="text-slate-400 font-normal">({b.invoices.length})</span>
                  </span>
                  <span className="font-semibold tabular-nums">{money(b.total)}</span>
                </button>
                {open.has(b.key) && (
                  <ul className="pb-2">
                    {b.invoices.map((inv) => (
                      <li key={inv.id}>
                        <Link
                          href={`/dashboard/invoices/${inv.id}`}
                          className="flex items-center justify-between gap-3 px-9 py-1.5 text-sm hover:bg-slate-50"
                        >
                          <span className="min-w-0 truncate">
                            <span className="text-slate-500">#{inv.invoice_number}</span> {inv.customers?.name ?? "—"}
                            {inv.daysOverdue > 0 && <span className="text-xs text-slate-400"> · {inv.daysOverdue} days late</span>}
                          </span>
                          <span className="tabular-nums">{money(inv.balance)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}
