"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Link2, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDate } from "@/lib/date";
import { LINK_SOURCE_LABEL, variationLinkError, type VariationLink, type VariationLinkSource } from "@/lib/variation-links";

// The costs the office links to one variation (0120 (draft), variation_cost_links):
// plant usage, expenses and supplier POs already on the job. A LINK — the
// amount is read from the record, so the Job Ledger costs it once, on the
// variation's row instead of its stage's. Office/admin only (RLS); the time
// against a variation is tagged on the Time tab instead.

export interface LinkableCost {
  source: VariationLinkSource;
  id: string;
  /** "Expense · Reece · $412.50 · 3 Nov" — built by the caller (office only). */
  label: string;
}

export function VariationCosts({
  variationId,
  rejected,
  links,
  candidates,
  onChange,
}: {
  variationId: string;
  rejected: boolean;
  /** Every link on the job's variations (so a cost linked elsewhere isn't offered). */
  links: VariationLink[];
  candidates: LinkableCost[];
  onChange: (links: VariationLink[]) => void;
}) {
  const [pick, setPick] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const mine = links.filter((l) => l.variation_id === variationId);
  const linked = new Set(links.map((l) => `${l.source}:${l.source_id}`));
  const label = new Map(candidates.map((c) => [`${c.source}:${c.id}`, c.label]));
  const free = candidates.filter((c) => !linked.has(`${c.source}:${c.id}`));

  async function link() {
    const c = free.find((x) => `${x.source}:${x.id}` === pick);
    if (!c) return;
    setBusy(true);
    const { data, error } = await createClient()
      .from("variation_cost_links")
      .insert({ variation_id: variationId, source: c.source, source_id: c.id })
      .select("id, variation_id, source, source_id")
      .single();
    setBusy(false);
    if (error || !data) {
      toast.error(variationLinkError(error));
      return;
    }
    setPick("");
    onChange([...links, data as VariationLink]);
  }

  async function unlink(l: VariationLink) {
    setBusy(true);
    const { error, count } = await createClient().from("variation_cost_links").delete({ count: "exact" }).eq("id", l.id);
    setBusy(false);
    if (error || count === 0) {
      toast.error("Couldn't unlink that cost.");
      return;
    }
    onChange(links.filter((x) => x.id !== l.id));
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-slate-600 flex items-center gap-1">
        <Link2 className="w-3 h-3" /> Costs linked to this variation
      </p>
      {mine.length === 0 && <p className="text-xs text-slate-400">None — link plant, an expense or a supplier PO that was for this variation.</p>}
      {mine.map((l) => (
        <div key={l.id} className="flex items-center justify-between gap-2 text-xs text-slate-600 bg-slate-50 rounded px-2 py-1">
          <span>{label.get(`${l.source}:${l.source_id}`) ?? `${LINK_SOURCE_LABEL[l.source]} (not on this page)`}</span>
          <button type="button" onClick={() => unlink(l)} disabled={busy} className="text-slate-400 hover:text-red-500" aria-label="Unlink">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      {!rejected && free.length > 0 && (
        <div className="flex items-center gap-2">
          <Select value={pick} onValueChange={(v) => setPick(v ?? "")}>
            <SelectTrigger className="h-7 text-xs flex-1 bg-white"><SelectValue placeholder="Link a cost on this job…" /></SelectTrigger>
            <SelectContent>
              {free.map((c) => (
                <SelectItem key={`${c.source}:${c.id}`} value={`${c.source}:${c.id}`}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!pick || busy} onClick={link}>Link</Button>
        </div>
      )}
    </div>
  );
}

const money = (n: number | string | null | undefined) =>
  n == null || n === "" ? "not priced" : `$${Number(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The job's linkable costs, labelled for the office's picker. */
export function linkableCosts(input: {
  expenses: { id: string; supplier_name?: string | null; description?: string | null; amount?: number | null; expense_date?: string | null; created_at?: string | null }[];
  vendorOrders: { id: string; po_number?: string | null; vendor_name?: string | null; amount?: number | null; status?: string | null }[];
  equipmentUsage: { id: string; equipment_id: string; hours?: number | null; loads?: number | null; usage_date?: string | null }[];
  equipmentName: (id: string) => string | null;
}): LinkableCost[] {
  const date = (d: string | null | undefined) => (d ? ` · ${formatDate(d)}` : "");
  return [
    ...input.equipmentUsage.map((u) => ({
      source: "equipment_usage" as const,
      id: u.id,
      label: `Plant · ${input.equipmentName(u.equipment_id) ?? "Machine"} · ${Number(u.hours ?? 0)} h${u.loads ? `, ${u.loads} loads` : ""}${date(u.usage_date)}`,
    })),
    ...input.expenses.map((e) => ({
      source: "job_expense" as const,
      id: e.id,
      label: `Expense · ${e.supplier_name || e.description || "Expense"} · ${money(e.amount)}${date(e.expense_date ?? e.created_at)}`,
    })),
    ...input.vendorOrders
      .filter((o) => o.status !== "cancelled")
      .map((o) => ({
        source: "vendor_order" as const,
        id: o.id,
        label: `Supplier PO ${o.po_number ?? ""} · ${o.vendor_name ?? "Supplier"} · ${money(o.amount)}`,
      })),
  ];
}
