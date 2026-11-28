"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2, Mail, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Supplier invoices read from the accounts Gmail label (0124, drafted). Office/admin
// only (the page is, and the table is by RLS). Matched ones are on their PO,
// flagged "from email — check": the office opens the job's PO tab, checks the
// invoice against the PDF and confirms before Send to Xero. The rest wait
// here: assign to a PO by number, or dismiss. Two kinds get a one-click
// action (28 Nov 2026, never done by itself): a credit note for one of our
// POs → "Apply credit to PO" (a credit under the order, 0125; the office
// enters it in Xero), and a bill quoting only a job number → "Add as job
// expense". Supplier statements are put away by the import; they and anything
// dismissed by hand sit in a collapsed "Dismissed" list with Reopen.

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
  /** The one-click action offered (lib/gmail-invoice-rules.ts reviewOffer). */
  offer: "credit" | "job_expense" | null;
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
  const [showDismissed, setShowDismissed] = useState(false);

  const review = rows.filter((r) => r.status === "needs_review" || r.status === "new");
  const matched = rows.filter((r) => r.status === "matched");
  const dismissed = rows.filter((r) => r.status === "dismissed");

  const done = (action: Action, body: { poNumber?: string; jobNumber?: number; already?: boolean }) => {
    if (action === "assign") return `On ${body.poNumber} — check it on the job's PO tab, then send to Xero`;
    if (action === "credit") return body.already ? "Already applied" : `Credit added under ${body.poNumber}. Enter the credit note in Xero too.`;
    if (action === "expense") return body.already ? "Already added" : `Added to job #${body.jobNumber}'s expenses`;
    return action === "dismiss" ? "Dismissed" : "Back in the review list";
  };

  async function act(id: string, action: Action, poNumber?: string) {
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
      toast.success(done(action, body));
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
      else toast.success(`${body.files ?? 0} new file(s): ${body.matched ?? 0} on a PO, ${body.needsReview ?? 0} to review${body.dismissed ? `, ${body.dismissed} statement(s) put away` : ""}${body.more ? " — more next run" : ""}`);
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
                {r.status === "needs_review" && r.offer === "credit" && r.po && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button size="sm" className="h-8 text-xs" disabled={busy !== null} onClick={() => act(r.id, "credit")}>
                      {busy === r.id ? "Saving…" : `Apply credit to ${r.po.po_number}`}
                    </Button>
                    <span className="text-xs text-slate-500">Adds it under the PO&apos;s invoice. Enter the credit note in Xero too — the app doesn&apos;t send credits.</span>
                  </div>
                )}
                {r.status === "needs_review" && r.offer === "job_expense" && r.job && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button size="sm" className="h-8 text-xs" disabled={busy !== null} onClick={() => act(r.id, "expense")}>
                      {busy === r.id ? "Saving…" : `Add as job expense on #${r.job.job_number}`}
                    </Button>
                    <span className="text-xs text-slate-500">or put it on a PO instead:</span>
                  </div>
                )}
                {r.status === "needs_review" && r.offer !== "credit" && (
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
                {r.status === "needs_review" && r.offer === "credit" && (
                  <Button size="sm" variant="ghost" className="h-8 text-xs text-slate-500" disabled={busy !== null} onClick={() => act(r.id, "dismiss")}>
                    Dismiss
                  </Button>
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
        {dismissed.length > 0 && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowDismissed((v) => !v)}
              className="flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-slate-700"
            >
              {showDismissed ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />} Dismissed — last 30 days ({dismissed.length})
            </button>
            {showDismissed &&
              dismissed.map((r) => (
                <div key={r.id} className="rounded border border-slate-200 bg-slate-50/60 p-3 flex items-start justify-between gap-3 text-sm">
                  <div className="min-w-0 space-y-1">
                    {header(r)}
                    {r.review_reason && <p className="text-xs text-slate-500">{r.review_reason}</p>}
                  </div>
                  <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" disabled={busy !== null} onClick={() => act(r.id, "reopen")}>
                    {busy === r.id ? "Saving…" : "Reopen"}
                  </Button>
                </div>
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type Action = "assign" | "dismiss" | "reopen" | "credit" | "expense";
