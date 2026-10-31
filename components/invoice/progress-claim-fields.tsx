"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { nextClaimDefaults, progressBreakdown } from "@/lib/progress-claim";

// "Progress claim" on New / Edit Invoice (migration 0084). Ticking it fills the
// claim number, contract value and previously-claimed amount from the job's
// latest claim in the app, else the Simpro job value; the office can change
// any of them — on a job's first claim here, "previously claimed" is where the
// amount already claimed in Simpro goes.

export interface ClaimDraft {
  on: boolean;
  number: string;
  contract: string;
  previous: string;
}

export const emptyClaimDraft: ClaimDraft = { on: false, number: "", contract: "", previous: "" };

export function claimDraftFromInvoice(inv: {
  is_progress_claim?: boolean | null;
  claim_number?: number | null;
  claim_contract_value?: number | string | null;
  claim_previous?: number | string | null;
}): ClaimDraft {
  if (!inv.is_progress_claim) return emptyClaimDraft;
  return {
    on: true,
    number: inv.claim_number != null ? String(inv.claim_number) : "",
    contract: inv.claim_contract_value != null ? String(Number(inv.claim_contract_value)) : "",
    previous: inv.claim_previous != null ? String(Number(inv.claim_previous)) : "0",
  };
}

/** The invoice columns for a draft, or the reason it cannot be saved. */
export function claimColumns(d: ClaimDraft):
  | { ok: true; columns: { is_progress_claim: boolean; claim_number: number | null; claim_contract_value: number | null; claim_previous: number | null } }
  | { ok: false; error: string } {
  if (!d.on) return { ok: true, columns: { is_progress_claim: false, claim_number: null, claim_contract_value: null, claim_previous: null } };
  const number = parseInt(d.number, 10);
  const contract = parseFloat(d.contract);
  const previous = d.previous.trim() === "" ? 0 : parseFloat(d.previous);
  if (!Number.isInteger(number) || number < 1) return { ok: false, error: "Enter the progress claim number" };
  if (!(contract > 0)) return { ok: false, error: "Enter the contract value (ex GST) for the progress claim" };
  if (Number.isNaN(previous) || previous < 0) return { ok: false, error: "Previously claimed must be 0 or more" };
  return { ok: true, columns: { is_progress_claim: true, claim_number: number, claim_contract_value: contract, claim_previous: previous } };
}

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ProgressClaimFields({
  value,
  onChange,
  jobId,
  currentInvoiceId,
  subtotal,
  builderPo,
}: {
  value: ClaimDraft;
  onChange: (d: ClaimDraft) => void;
  jobId: string | null;
  /** Edit Invoice: leave this invoice out when looking for the previous claim. */
  currentInvoiceId?: string;
  /** This claim, ex GST. */
  subtotal: number;
  /**
   * The builder PO this claim is against (Stage 2 left this open: a job holds
   * a PO per stage). When set, the contract value is that PO's value and the
   * previous claims are the ones on that PO number — not the whole job's.
   */
  builderPo?: { poNumber: string; value: number } | null;
}) {
  // Prefill once per tick-on (and again if the job changes while ticked), but
  // never over figures already on the invoice.
  const prefillKey = `${jobId}:${builderPo?.poNumber ?? ""}`;
  const prefilledFor = useRef<string | null>(value.on && value.contract ? prefillKey : null);

  useEffect(() => {
    if (!value.on || !jobId || prefilledFor.current === prefillKey) return;
    prefilledFor.current = prefillKey;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      let latestQ = supabase
        .from("invoices")
        .select("claim_number, claim_contract_value, claim_previous, subtotal")
        .eq("job_id", jobId)
        .eq("is_progress_claim", true)
        .order("claim_number", { ascending: false })
        .limit(1);
      if (currentInvoiceId) latestQ = latestQ.neq("id", currentInvoiceId);
      if (builderPo) latestQ = latestQ.eq("customer_po", builderPo.poNumber);
      const [{ data: latest }, { data: pos }] = await Promise.all([
        latestQ,
        supabase.from("purchase_orders").select("total_value").eq("job_id", jobId),
      ]);
      if (cancelled) return;
      const simproValue = builderPo
        ? builderPo.value || null
        : (pos ?? []).reduce((s, p) => s + Number(p.total_value ?? 0), 0) || null;
      const d = nextClaimDefaults(latest?.[0] ?? null, simproValue);
      onChange({
        on: true,
        number: String(d.claimNumber),
        contract: d.contractValue != null ? String(d.contractValue) : "",
        previous: String(d.previous),
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.on, jobId, builderPo?.poNumber]);

  const contract = parseFloat(value.contract);
  const preview =
    value.on && contract > 0
      ? progressBreakdown({
          claimNumber: parseInt(value.number, 10) || 1,
          contractValue: contract,
          previous: parseFloat(value.previous) || 0,
          thisClaim: subtotal,
        })
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <input
            id="progress-claim"
            type="checkbox"
            className="h-4 w-4"
            checked={value.on}
            onChange={(e) => onChange({ ...value, on: e.target.checked })}
          />
          <label htmlFor="progress-claim">Progress claim</label>
        </CardTitle>
      </CardHeader>
      {value.on && (
        <CardContent className="space-y-4">
          {!jobId && <p className="text-xs text-amber-700">Link a job to fill these in from its earlier claims.</p>}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="claim-number">Claim no.</Label>
              <Input id="claim-number" type="number" min={1} step={1} value={value.number} onChange={(e) => onChange({ ...value, number: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="claim-contract">Contract value (ex GST)</Label>
              <Input id="claim-contract" type="number" min={0} step="0.01" value={value.contract} onChange={(e) => onChange({ ...value, contract: e.target.value })} placeholder="e.g. 9200" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="claim-previous">Previously claimed (ex GST)</Label>
              <Input id="claim-previous" type="number" min={0} step="0.01" value={value.previous} onChange={(e) => onChange({ ...value, previous: e.target.value })} placeholder="0" />
            </div>
          </div>
          <p className="text-xs text-slate-400">
            Filled from this job&rsquo;s last claim, or the Simpro job value. On the first claim raised here, add anything already
            claimed in Simpro to &ldquo;Previously claimed&rdquo;.
          </p>
          {preview && (
            <div className="rounded-md bg-slate-50 border p-3 space-y-2">
              <div className="h-2 w-full rounded bg-white border overflow-hidden flex">
                <div className="bg-slate-400" style={{ width: `${Math.min(100, Math.max(0, preview.pctPrevious))}%` }} />
                <div className="bg-slate-800" style={{ width: `${Math.min(100 - Math.min(100, Math.max(0, preview.pctPrevious)), Math.max(0, preview.pctThis))}%` }} />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <div><p className="text-slate-500">Previously claimed</p><p className="font-semibold">{money(preview.previous)} · {preview.pctPrevious}%</p></div>
                <div><p className="text-slate-500">This claim</p><p className="font-semibold">{money(preview.thisClaim)} · {preview.pctThis}%</p></div>
                <div><p className="text-slate-500">Claimed to date</p><p className="font-semibold">{money(preview.toDate)} · {preview.pctToDate}%</p></div>
                <div>
                  <p className="text-slate-500">Balance to claim</p>
                  <p className={`font-semibold ${preview.balance < 0 ? "text-red-600" : ""}`}>{money(preview.balance)}</p>
                </div>
              </div>
              {preview.balance < 0 && <p className="text-xs text-red-600">This claim takes the job over its contract value.</p>}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
