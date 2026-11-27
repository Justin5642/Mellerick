"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Loader2, Mail, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Supplier invoices read from the accounts Gmail label (0124, drafted). Office/admin
// only (the page is, and the table is by RLS). Matched ones are on their PO,
// flagged "from email — check": the office opens the job's PO tab, checks the
// invoice against the PDF and confirms before Send to Xero. The rest wait
// here: assign to a PO by number, or dismiss.

export interface EmailedInvoice {
  id: string;
  status: "new" | "matched" | "needs_review" | "dismissed";
  received_at: string | null;
  sender: string | null;
  subject: string | null;
  file_name: string | null;
  review_reason: string | null;
  supplier_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  amount_ex_gst: number | null;
  gst_amount: number | null;
  po_refs: string[];
  job_refs: string[];
  fileUrl: string | null;
  po: { po_number: string; job_id: string; invoice_needs_check: boolean | null } | null;
  job: { job_number: number; title: string } | null;
}

export interface GmailState {
  label_name: string;
  gmail_allowed: boolean | null;
  last_poll_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
}

const money = (n: number | null) => (n === null ? "—" : `$${Number(n).toFixed(2)}`);
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-AU", { timeZone: "Australia/Melbourne", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";

export function EmailedInvoicesPanel({
  rows,
  state,
  canCheckNow,
}: {
  rows: EmailedInvoice[];
  state: GmailState | null;
  canCheckNow: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [po, setPo] = useState<Record<string, string>>({});

  const review = rows.filter((r) => r.status === "needs_review" || r.status === "new");
  const matched = rows.filter((r) => r.status === "matched");

  async function act(id: string, action: "assign" | "dismiss", poNumber?: string) {
    setBusy(id);
    try {
      const res = await fetch(`/api/gmail/invoices/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, poNumber }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Couldn't update the invoice");
        return;
      }
      toast.success(action === "assign" ? `On ${body.poNumber} — check it on the job's PO tab, then send to Xero` : "Dismissed");
      router.refresh();
    } catch {
      toast.error("Couldn't reach the server. Check your connection.");
    } finally {
      setBusy(null);
    }
  }

  async function checkNow() {
    setBusy("check");
    try {
      const res = await fetch("/api/gmail/poll-invoices", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(body.error ?? "Couldn't check Gmail");
      else if (body.skipped) toast.message("Gmail wasn't checked — see the note above the list.");
      else toast.success(`${body.files ?? 0} new file(s): ${body.matched ?? 0} on a PO, ${body.needsReview ?? 0} to review${body.more ? " — more next run" : ""}`);
      router.refresh();
    } catch {
      toast.error("Couldn't reach the server. Check your connection.");
    } finally {
      setBusy(null);
    }
  }

  const header = (r: EmailedInvoice) => (
    <div className="min-w-0">
      <p className="font-medium text-slate-800 truncate">
        {r.supplier_name ?? r.sender ?? "Unknown sender"}
        {r.invoice_number && <span className="font-mono font-normal text-slate-500"> · {r.invoice_number}</span>}
      </p>
      <p className="text-xs text-slate-500 truncate">
        {when(r.received_at)} · {r.subject ?? "(no subject)"}
        {r.file_name && (
          <>
            {" · "}
            {r.fileUrl ? (
              <a href={r.fileUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{r.file_name}</a>
            ) : (
              r.file_name
            )}
          </>
        )}
      </p>
      <p className="text-xs text-slate-600">
        {r.invoice_date ?? "no date"} · {money(r.amount_ex_gst)} ex GST · GST {money(r.gst_amount)}
        {r.po_refs.length > 0 && ` · quotes ${r.po_refs.join(", ")}`}
        {r.job_refs.length > 0 && ` · job ref ${r.job_refs.join(", ")}`}
      </p>
    </div>
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Mail className="w-4 h-4 text-blue-600" /> Emailed supplier invoices
            </CardTitle>
            <p className="text-xs text-slate-500 mt-1">
              {state
                ? `Read hourly from the Gmail label "${state.label_name}". Last checked ${when(state.last_poll_at)}.`
                : "Reading supplier invoices from Gmail isn't switched on yet."}
            </p>
          </div>
          {canCheckNow && state && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={checkNow} disabled={busy !== null}>
              {busy === "check" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Check now
            </Button>
          )}
        </div>
        {state?.last_error && (
          <p className="mt-2 flex items-center gap-2 rounded bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {state.last_error}
            {state.gmail_allowed === false && (
              <Link href="/dashboard/settings" className="underline font-medium">Settings</Link>
            )}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-700">Needs review ({review.length})</h3>
          {review.length === 0 ? (
            <p className="text-sm text-slate-400">Nothing waiting.</p>
          ) : (
            review.map((r) => (
              <div key={r.id} className="rounded border border-amber-200 bg-amber-50/40 p-3 space-y-2 text-sm">
                {header(r)}
                <p className="text-xs text-amber-800">{r.status === "new" ? "Being read…" : r.review_reason}</p>
                {r.status === "needs_review" && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Input
                      value={po[r.id] ?? r.po_refs[0] ?? ""}
                      onChange={(e) => setPo((p) => ({ ...p, [r.id]: e.target.value }))}
                      placeholder="PO number, e.g. 1234"
                      className="h-8 w-44 text-xs"
                    />
                    <Button size="sm" className="h-8 text-xs" disabled={busy !== null} onClick={() => act(r.id, "assign", po[r.id] ?? r.po_refs[0] ?? "")}>
                      {busy === r.id ? "Saving…" : "Put on this PO"}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8 text-xs text-slate-500" disabled={busy !== null} onClick={() => act(r.id, "dismiss")}>
                      Dismiss
                    </Button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-700">Put on a PO — last 30 days ({matched.length})</h3>
          {matched.length === 0 ? (
            <p className="text-sm text-slate-400">None yet.</p>
          ) : (
            matched.map((r) => (
              <div key={r.id} className="rounded border border-slate-200 p-3 flex items-start justify-between gap-3 text-sm">
                {header(r)}
                {r.po && (
                  <div className="text-right text-xs shrink-0">
                    <Link href={`/dashboard/jobs/${r.po.job_id}?tab=po`} className="font-mono font-semibold text-blue-600 hover:underline">
                      {r.po.po_number}
                    </Link>
                    {r.job && <p className="text-slate-500">#{r.job.job_number}</p>}
                    {r.po.invoice_needs_check ? (
                      <p className="text-amber-700 font-medium">Check and send to Xero</p>
                    ) : (
                      <p className="text-green-700 flex items-center gap-1 justify-end"><CheckCircle2 className="w-3 h-3" /> Checked</p>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
