"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, FileText, Loader2, Undo2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Match } from "@/lib/supplier-invoice-match";

export interface SupplierInvoiceRow {
  id: string;
  storage_path: string;
  file_name: string;
  index_in_file: number;
  created_at: string;
  status: "reading" | "read" | "failed" | "costed" | "dismissed";
  read_error: string | null;
  doc_kind: "invoice" | "credit_note" | "statement" | "other" | null;
  supplier_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  amount_ex_gst: number | null;
  gst_amount: number | null;
  total: number | null;
  po_refs: string[];
  job_refs: string[];
  site_text: string | null;
  duplicate_of: string | null;
  job_id: string | null;
  vendor_order_id: string | null;
  job_expense_id: string | null;
  costed_at: string | null;
}

export interface CostedLabel { job: string | null; po: string | null }

const KIND: Record<string, string> = { invoice: "Invoice", credit_note: "Credit note", statement: "Statement", other: "Not an invoice" };
const CATEGORIES = [
  ["materials", "Materials"],
  ["subcontractor", "Subcontractor"],
  ["equipment_hire", "Equipment hire"],
  ["other", "Other"],
] as const;

const money = (n: number | null) =>
  n == null ? "—" : `$${Number(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-AU") : "—");

/**
 * The day's supplier invoices, sorted by what still needs doing:
 *   Ready to cost — matched to one of our POs, or to a job by number/site.
 *   Needs a job — read, but nothing matched (or the match can't be used).
 *   Other documents — statements, non-invoices, repeats, unreadable files.
 *   Done — costed or dismissed in the last 30 days.
 * Costing happens on the server (/api/supplier-invoices/cost), which re-checks
 * the match itself; dismissing is a plain status change the office may make.
 */
export function SupplierInvoiceReview({
  rows,
  matches,
  costedLabels,
  matchFailed,
}: {
  rows: SupplierInvoiceRow[];
  matches: Record<string, Match>;
  costedLabels: Record<string, CostedLabel>;
  matchFailed: boolean;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [bulk, setBulk] = useState(false);

  const ready = rows.filter((r) => r.status === "read" && !r.duplicate_of && isUsable(matches[r.id]));
  const needs = rows.filter((r) => r.status === "read" && !r.duplicate_of && isInvoice(r) && !isUsable(matches[r.id]));
  const other = rows.filter((r) => (r.status === "read" && (r.duplicate_of || !isInvoice(r))) || r.status === "failed");
  const done = rows.filter((r) => r.status === "costed" || r.status === "dismissed");
  const poReady = ready.filter((r) => matches[r.id]?.kind === "po");

  async function cost(r: SupplierInvoiceRow, opts: { target?: string; category?: string } = {}, quiet = false): Promise<boolean> {
    setBusy((b) => ({ ...b, [r.id]: true }));
    try {
      const res = await fetch("/api/supplier-invoices/cost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id, ...opts }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(`${r.supplier_name ?? "Invoice"} ${r.invoice_number ?? ""}: ${data.error ?? `server returned ${res.status}`}`); return false; }
      if (!quiet) toast.success(data.kind === "po" ? `Saved on ${data.poNumber}` : `Added to job #${data.jobNumber}`);
      return true;
    } catch {
      toast.error("Couldn't reach the server. Check your connection.");
      return false;
    } finally {
      setBusy((b) => ({ ...b, [r.id]: false }));
    }
  }

  async function costAndRefresh(r: SupplierInvoiceRow, opts: { target?: string; category?: string } = {}) {
    if (await cost(r, opts)) router.refresh();
  }

  async function costAllPos() {
    setBulk(true);
    let ok = 0;
    for (const r of poReady) if (await cost(r, {}, true)) ok++;
    setBulk(false);
    if (ok) toast.success(`${ok} invoice${ok === 1 ? "" : "s"} saved on their POs`);
    router.refresh();
  }

  async function setStatus(r: SupplierInvoiceRow, status: "dismissed" | "read") {
    setBusy((b) => ({ ...b, [r.id]: true }));
    const { error, count } = await supabase
      .from("supplier_invoices")
      .update({ status }, { count: "exact" })
      .eq("id", r.id)
      .eq("status", status === "dismissed" ? r.status : "dismissed");
    setBusy((b) => ({ ...b, [r.id]: false }));
    if (error || count === 0) { toast.error("Couldn't update it. Reload and try again."); return; }
    router.refresh();
  }

  async function openPdf(path: string) {
    const { data, error } = await supabase.storage.from("supplier-invoices").createSignedUrl(path, 60);
    if (error || !data) { toast.error("Couldn't open the PDF"); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  }

  const pdf = (r: SupplierInvoiceRow) => (
    <button type="button" onClick={() => openPdf(r.storage_path)} className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
      <FileText className="w-3.5 h-3.5" />PDF
    </button>
  );

  const head = (r: SupplierInvoiceRow) => (
    <div className="min-w-0">
      <p className="text-sm font-medium text-slate-900 truncate">
        {r.supplier_name ?? <span className="text-slate-400">Unknown supplier</span>}
        {r.doc_kind && r.doc_kind !== "invoice" && (
          <span className="ml-2 text-[11px] rounded bg-slate-100 px-1.5 py-0.5 font-normal text-slate-600">{KIND[r.doc_kind]}</span>
        )}
      </p>
      <p className="text-xs text-slate-500">
        <span className="font-mono">{r.invoice_number ?? "no number"}</span> · {day(r.invoice_date)} ·{" "}
        <span className="tabular-nums text-slate-700">{money(r.amount_ex_gst)}</span> ex GST · {pdf(r)}
      </p>
    </div>
  );

  return (
    <div className="space-y-6">
      {matchFailed && <p className="text-sm text-red-600">Matching couldn&apos;t run, so everything shows under &ldquo;Needs a job&rdquo;. Reload the page.</p>}

      <Section
        title="Ready to cost"
        count={ready.length}
        empty="Nothing waiting. Drop today's PDFs above."
        action={poReady.length > 1 ? (
          <Button size="sm" onClick={costAllPos} disabled={bulk}>
            {bulk ? <Loader2 className="w-4 h-4 animate-spin" /> : null}Save all {poReady.length} on their POs
          </Button>
        ) : null}
      >
        {ready.map((r) => (
          <ReadyRow key={r.id} r={r} m={matches[r.id] as Usable} head={head(r)} busy={!!busy[r.id] || bulk}
            onCost={(o) => costAndRefresh(r, o)} onDismiss={() => setStatus(r, "dismissed")} />
        ))}
      </Section>

      <Section title="Needs a job" count={needs.length} empty="Every invoice found its job.">
        {needs.map((r) => (
          <NeedsRow key={r.id} r={r} m={matches[r.id]} head={head(r)} busy={!!busy[r.id]}
            onCost={(o) => costAndRefresh(r, o)} onDismiss={() => setStatus(r, "dismissed")} />
        ))}
      </Section>

      {other.length > 0 && (
        <Section title="Other documents" count={other.length} empty="">
          {other.map((r) => (
            <Row key={r.id}>
              {r.status === "failed" ? (
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 truncate">{r.file_name}</p>
                  <p className="text-xs text-red-600 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{r.read_error ?? "Couldn't be read"} · {pdf(r)}</p>
                </div>
              ) : head(r)}
              <span className="text-xs text-slate-500 sm:ml-auto">
                {r.duplicate_of ? "Already received in an earlier file" : r.status === "failed" ? "Enter it on the job by hand" : "Nothing to cost"}
              </span>
              <Button size="sm" variant="outline" disabled={!!busy[r.id]} onClick={() => setStatus(r, "dismissed")}>Dismiss</Button>
            </Row>
          ))}
        </Section>
      )}

      {done.length > 0 && (
        <Section title="Done" count={done.length} empty="">
          {done.map((r) => {
            const label = costedLabels[r.id];
            return (
              <Row key={r.id} className="opacity-80">
                {head(r)}
                {r.status === "costed" ? (
                  <span className="text-xs text-green-700 flex items-center gap-1 sm:ml-auto">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {label?.po ? `On ${label.po}` : "Job expense"}
                    {r.job_id && label?.job && <> · <Link prefetch={false} href={`/dashboard/jobs/${r.job_id}`} className="text-blue-600 hover:underline">{label.job}</Link></>}
                  </span>
                ) : (
                  <>
                    <span className="text-xs text-slate-500 sm:ml-auto">Dismissed</span>
                    <Button size="sm" variant="ghost" className="gap-1" disabled={!!busy[r.id]} onClick={() => setStatus(r, "read")}>
                      <Undo2 className="w-3.5 h-3.5" />Undo
                    </Button>
                  </>
                )}
              </Row>
            );
          })}
        </Section>
      )}
    </div>
  );
}

type Usable = Extract<Match, { kind: "po" | "job" }>;
const isUsable = (m: Match | undefined): m is Usable => !!m && m.kind !== "none" && !m.blocked;
const isInvoice = (r: SupplierInvoiceRow) => r.doc_kind === "invoice" || r.doc_kind === "credit_note";

function Section({ title, count, empty, action, children }: { title: string; count: number; empty: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          {title}
          <span className="text-xs font-normal rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{count}</span>
          {action && <span className="ml-auto">{action}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {count === 0 ? <p className="text-sm text-slate-400 px-6 pb-4">{empty}</p> : <div className="divide-y divide-slate-100">{children}</div>}
      </CardContent>
    </Card>
  );
}

function Row({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("px-6 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4", className)}>{children}</div>;
}

function Notes({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return (
    <ul className="text-xs text-amber-700 space-y-0.5">
      {notes.map((n) => <li key={n} className="flex items-start gap-1"><AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />{n}</li>)}
    </ul>
  );
}

function TargetInput({ busy, onCost, isCredit }: { busy: boolean; onCost: (o: { target: string; category: string }) => void; isCredit: boolean }) {
  const [target, setTarget] = useState("");
  const [category, setCategory] = useState("materials");
  return (
    <form
      className="flex items-center gap-2 flex-wrap"
      onSubmit={(e) => { e.preventDefault(); if (target.trim()) onCost({ target, category }); }}
    >
      <input
        aria-label="PO or job number"
        placeholder={isCredit ? "job 2542" : "PO-1008 or job 2542"}
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="h-8 w-44 rounded-md border border-slate-200 px-2 text-sm"
      />
      <CategorySelect value={category} onChange={setCategory} />
      <Button size="sm" type="submit" disabled={busy || !target.trim()}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Cost"}</Button>
    </form>
  );
}

function CategorySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select aria-label="Expense category" value={value} onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm">
      {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

function ReadyRow({ r, m, head, busy, onCost, onDismiss }: {
  r: SupplierInvoiceRow; m: Usable; head: React.ReactNode; busy: boolean;
  onCost: (o: { target?: string; category?: string }) => void; onDismiss: () => void;
}) {
  const [changing, setChanging] = useState(false);
  const [category, setCategory] = useState("materials");
  const job = m.kind === "po" ? m.job : m.job;
  const where = job ? `#${job.job_number} ${job.title}${job.address_line1 ? ` · ${job.address_line1}` : ""}` : "";
  return (
    <div className="px-6 py-3 space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        {head}
        <div className="text-xs sm:ml-auto sm:text-right min-w-0">
          {m.kind === "po" ? (
            <p><span className="rounded bg-green-100 px-1.5 py-0.5 font-mono text-green-800">{m.po.po_number}</span> <span className="text-slate-500">on</span> <span className="text-slate-700">{where}</span></p>
          ) : (
            <p><span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-800">Job expense</span> <span className="text-slate-700">{where}</span> <span className="text-slate-400">(by {m.via})</span></p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {m.kind === "job" && !changing && <CategorySelect value={category} onChange={setCategory} />}
          {!changing && (
            <Button size="sm" disabled={busy} onClick={() => onCost(m.kind === "job" ? { category } : {})}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : m.kind === "po" ? `Save on ${m.po.po_number}` : "Add to job"}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setChanging((c) => !c)}>{changing ? "Cancel" : "Change"}</Button>
          <Button size="sm" variant="ghost" className="text-slate-500" disabled={busy} onClick={onDismiss}>Dismiss</Button>
        </div>
      </div>
      <Notes notes={m.notes} />
      {changing && <TargetInput busy={busy} onCost={onCost} isCredit={r.doc_kind === "credit_note"} />}
    </div>
  );
}

function NeedsRow({ r, m, head, busy, onCost, onDismiss }: {
  r: SupplierInvoiceRow; m: Match | undefined; head: React.ReactNode; busy: boolean;
  onCost: (o: { target?: string; category?: string }) => void; onDismiss: () => void;
}) {
  const refs = [...(r.po_refs ?? []), ...(r.job_refs ?? [])];
  const notes = [...(m && m.kind !== "none" && m.blocked ? [m.blocked] : []), ...(m?.notes ?? [])];
  return (
    <div className="px-6 py-3 space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        {head}
        <div className="text-xs text-slate-500 sm:ml-auto min-w-0 sm:max-w-xs">
          {refs.length > 0 && <p className="truncate">Ref: {refs.join(" · ")}</p>}
          {r.site_text && <p className="truncate">Site: {r.site_text}</p>}
          {!refs.length && !r.site_text && <p>No order ref or site printed</p>}
        </div>
        <Button size="sm" variant="ghost" className="text-slate-500 shrink-0" disabled={busy} onClick={onDismiss}>Dismiss</Button>
      </div>
      <Notes notes={notes} />
      <TargetInput busy={busy} onCost={onCost} isCredit={r.doc_kind === "credit_note"} />
    </div>
  );
}
