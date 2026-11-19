"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, FileImage, Lock, Truck, XCircle } from "lucide-react";
import { DIRECTION_LABELS, loadQuantityText, loadRoute } from "@/lib/cartage-pricing";
import type { TruckLoad, TruckLoadsView } from "@/lib/cartage-view";

// "Truck loads" on the job's Day Works tab (0111, drafted — not applied yet). The driver logs each trip
// on the phone — quarry product in, spoil out to a tip — with its docket; the
// builder's rep signs the day's extras there. Here the office enters each
// load's docket cost (and a margin override), sees each extra's price
// breakdown, sets whether quarry product is included on this job, and voids a
// signed load. Signed extras are invoiced with the Day Works below.
//
// Reads come from GET /api/jobs/[id]/cartage-loads (quantities for the crew;
// costs and prices only for office/admin). The office's writes go through the
// office-only routes the phone uses too (lib/day-works-office.ts): .../quarry,
// .../[loadId]/void and .../[loadId]/cost — the caller's own session, so RLS
// and 0111's triggers decide as before.

export type TruckLoadsLoaded = TruckLoadsView & { ready: true; isOffice: boolean; userId: string };
type State = { status: "loading" } | { status: "error" } | { status: "not-ready" } | ({ status: "ok" } & TruckLoadsLoaded);

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

/** An office write through its route; the route's own sentence on refusal. */
async function officeWrite(url: string, method: "PUT" | "POST", body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return { ok: true };
    const b = await res.json().catch(() => ({}));
    return { ok: false, error: typeof b.error === "string" ? b.error : undefined };
  } catch {
    return { ok: false };
  }
}

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  signed: "bg-green-100 text-green-800",
  invoiced: "bg-blue-100 text-blue-800",
  void: "bg-red-50 text-red-700 line-through",
};

/** "Spoil out · 12 t · Job site → Wollert tip · 35 km · docket 1234". No money. */
export function loadSummary(l: TruckLoad, siteLabel: string | null): string {
  const what = l.direction === "material_in" ? l.material || "Quarry product" : "Spoil";
  const route = loadRoute(l, siteLabel);
  return [what, l.quantity == null ? "quantity not entered" : loadQuantityText(l.quantity, l.unit), route, l.km == null ? null : `${l.km} km`, l.docket_number ? `docket ${l.docket_number}` : null]
    .filter(Boolean)
    .join(" · ");
}

export function JobTruckLoads({ jobId, readOnly = false, onLoaded, reloadKey = 0 }: {
  jobId: string;
  readOnly?: boolean;
  /** The parent's Invoice Day Works needs the signed extras and their prices. */
  onLoaded?: (view: TruckLoadsLoaded | null) => void;
  /** Bump to reload (after an invoice is made). */
  reloadKey?: number;
}) {
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/cartage-loads`);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        onLoaded?.(null);
        return setState({ status: "error" });
      }
      if (!body.ready) {
        onLoaded?.(null);
        return setState({ status: "not-ready" });
      }
      setState({ status: "ok", ...(body as TruckLoadsLoaded) });
      onLoaded?.(body as TruckLoadsLoaded);
    } catch {
      onLoaded?.(null);
      setState({ status: "error" });
    }
  }, [jobId, onLoaded]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  if (state.status === "loading") return <div className="text-sm text-slate-400">Loading truck loads…</div>;
  if (state.status === "error")
    return (
      <div className="text-sm text-red-600">
        Couldn&apos;t load the truck loads. <button className="underline" onClick={() => void load()}>Try again</button>
      </div>
    );
  if (state.status === "not-ready")
    return <p className="text-sm text-slate-500">Truck loads aren&apos;t switched on yet — the database update for them still has to be applied.</p>;

  const view = state;

  async function setQuarryDefault(value: string) {
    const next = value === "extra" ? false : value === "included" ? true : null;
    const res = await officeWrite(`/api/jobs/${jobId}/cartage-loads/quarry`, "PUT", { quarry_included: next });
    if (!res.ok) return toast.error(res.error ?? "Couldn't change it. Only the office can.");
    toast.success("Saved — new quarry loads on this job will default to that.");
    await load();
  }

  async function voidLoad(l: TruckLoad) {
    const reason = window.prompt(`Void the signed load of ${fmtDate(l.load_date)}? Say why:`);
    if (reason === null) return;
    const res = await officeWrite(`/api/jobs/${jobId}/cartage-loads/${l.id}/void`, "POST", { reason });
    if (!res.ok) return toast.error(res.error ?? "Couldn't void it. Take it off its invoice first if it's on one.");
    toast.success("Load voided");
    await load();
  }

  const byDate = new Map<string, TruckLoad[]>();
  for (const l of view.loads) (byDate.get(l.load_date) ?? byDate.set(l.load_date, []).get(l.load_date)!).push(l);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2"><Truck className="w-4 h-4" />Truck loads</h2>
        <p className="text-sm text-slate-500">
          Quarry product in and spoil out, one line per trip, logged by the driver on the phone. Extra loads are signed by the builder&apos;s rep and invoiced with the Day Works; included loads are a cost only.
        </p>
      </div>

      {view.isOffice && !readOnly && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-600">Quarry product on this job:</span>
          <select
            className="border rounded-md px-2 py-1 text-sm"
            value={view.quarryIncluded === false ? "extra" : view.quarryIncluded === true ? "included" : ""}
            onChange={(e) => void setQuarryDefault(e.target.value)}
            aria-label="Quarry product on this job"
          >
            <option value="">Included in the quote (default)</option>
            <option value="included">Included in the quote</option>
            <option value="extra">Extra — charged to the builder</option>
          </select>
          <span className="text-xs text-slate-400">Spoil out is extra by default. The driver can change either on a load.</span>
        </div>
      )}

      {view.pricing && (
        <p className="text-xs text-slate-500">
          Extras priced at docket cost + {view.pricing.companyMarginPct}% (Settings) + km at the truck&apos;s rate; spoil also per tonne / m³ at the truck&apos;s rate (Fleet → Hire setup).
          {view.pricing.uninvoicedSigned > 0 && <> Signed, not yet invoiced: <span className="font-medium">{money(view.pricing.uninvoicedSigned)}</span> ex GST.</>}
        </p>
      )}

      {view.loads.length === 0 ? (
        <p className="text-sm text-slate-400">No truck loads on this job yet.</p>
      ) : (
        [...byDate.entries()].map(([date, list]) => (
          <div key={date} className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{fmtDate(date)}</h3>
            {list.map((l) => (
              <LoadCard key={l.id} jobId={jobId} load={l} view={view} readOnly={readOnly} onSaved={load} onVoid={() => void voidLoad(l)} />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

function LoadCard({ jobId, load: l, view, readOnly, onSaved, onVoid }: { jobId: string; load: TruckLoad; view: TruckLoadsLoaded; readOnly: boolean; onSaved: () => Promise<void>; onVoid: () => void }) {
  const price = view.pricing?.loads[l.id];
  const [cost, setCost] = useState(price?.docketCost?.toString() ?? "");
  const [margin, setMargin] = useState(price?.marginOverride?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const locked = l.status === "invoiced" || l.status === "void";

  async function saveCost() {
    const c = cost.trim() === "" ? null : Number(cost);
    const m = margin.trim() === "" ? null : Number(margin);
    if ((c !== null && (!Number.isFinite(c) || c < 0)) || (m !== null && (!Number.isFinite(m) || m < 0 || m > 1000))) {
      return toast.error("Check the docket cost and margin.");
    }
    setSaving(true);
    try {
      const res = await officeWrite(`/api/jobs/${jobId}/cartage-loads/${l.id}/cost`, "PUT", { docket_cost_ex_gst: c, margin_pct: m });
      if (!res.ok) return toast.error(res.error ?? "Couldn't save the docket cost. It's locked once the load is invoiced.");
      toast.success("Docket cost saved");
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={l.status === "void" ? "opacity-60" : ""}>
      <CardContent className="p-4 space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium text-sm text-slate-900">
              {DIRECTION_LABELS[l.direction]} <span className="text-slate-500 font-normal">· {l.truck}</span>
              <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${l.billing === "extra" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"}`}>
                {l.billing === "extra" ? "Extra" : "Included"}
              </span>
            </p>
            <p className="text-sm text-slate-700">{loadSummary(l, view.siteLabel)}</p>
            <p className="text-xs text-slate-400 mt-1">
              {l.cost_centre ?? "No cost centre"}
              {l.created_by_name ? ` · logged by ${l.created_by_name}` : ""}
              {l.has_docket_photo && !price?.docketPhotoUrl ? " · docket photo attached" : ""}
            </p>
          </div>
          <div className="text-right space-y-1">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${STATUS_STYLE[l.status] ?? ""}`}>{l.status}</span>
            {price && l.billing === "extra" && (
              <p className="text-sm font-medium tabular-nums">{price.total === null ? <span className="text-amber-700">Not priced</span> : money(price.total)}</p>
            )}
          </div>
        </div>

        {price?.docketPhotoUrl && (
          <a href={price.docketPhotoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-600 underline">
            <FileImage className="w-3.5 h-3.5" />View docket photo
          </a>
        )}

        {l.status !== "draft" && l.signer_name && (
          <div className="flex items-center gap-3 rounded-md bg-slate-50 p-2 text-xs text-slate-600">
            <Lock className="w-3.5 h-3.5 shrink-0" />
            <span>
              Signed by {l.signer_name}
              {l.signed_at ? ` on ${new Date(l.signed_at).toLocaleString("en-AU", { timeZone: "Australia/Melbourne", dateStyle: "medium", timeStyle: "short" })}` : ""}. Locked.
            </span>
            {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL */}
            {l.signature_url && <img src={l.signature_url} alt={`Signature of ${l.signer_name}`} className="h-10 ml-auto bg-white rounded border" />}
          </div>
        )}
        {l.status === "void" && l.void_reason && <p className="text-xs text-red-700">Void: {l.void_reason}</p>}
        {l.status === "invoiced" && view.isOffice && l.invoice_id && (
          <a href={`/dashboard/invoices/${l.invoice_id}`} className="text-xs text-blue-600 underline">Open the invoice</a>
        )}

        {price && (
          <div className="rounded-md border border-slate-200 p-3 space-y-2 text-sm">
            {price.lines.length > 0 && (
              <div className="space-y-0.5">
                {price.lines.map((ln) => (
                  <div key={ln.label} className="flex justify-between text-slate-600">
                    <span>{ln.label}</span>
                    <span className="tabular-nums">{money(ln.amount)}</span>
                  </div>
                ))}
              </div>
            )}
            {price.problem && (
              <p className="flex gap-1.5 text-xs text-amber-700"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{price.problem}</p>
            )}
            {!readOnly && !locked ? (
              <div className="flex flex-wrap items-end gap-2">
                <label className="space-y-1">
                  <span className="block text-xs text-slate-500">{l.direction === "spoil_out" ? "Tip fee" : "Product cost"} (docket, ex GST)</span>
                  <Input type="number" inputMode="decimal" min={0} step={0.01} value={cost} onChange={(e) => setCost(e.target.value)} className="w-36" />
                </label>
                <label className="space-y-1">
                  <span className="block text-xs text-slate-500">Margin % (blank = {view.pricing?.companyMarginPct}%)</span>
                  <Input type="number" inputMode="decimal" min={0} step={0.5} value={margin} onChange={(e) => setMargin(e.target.value)} className="w-28" />
                </label>
                <Button size="sm" variant="outline" onClick={() => void saveCost()} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
              </div>
            ) : (
              price.docketCost !== null && <p className="text-xs text-slate-500">Docket cost {money(price.docketCost)} ex GST · margin {price.marginPct}%</p>
            )}
          </div>
        )}

        {view.isOffice && !readOnly && l.status === "signed" && (
          <Button size="sm" variant="ghost" className="gap-1.5 text-slate-500 hover:text-red-600" onClick={onVoid}>
            <XCircle className="w-3.5 h-3.5" />Void
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** Card wrapper used by the Day Works tab. */
export function TruckLoadsCard(props: Parameters<typeof JobTruckLoads>[0]) {
  return (
    <Card>
      <CardHeader className="pb-0"><CardTitle className="sr-only">Truck loads</CardTitle></CardHeader>
      <CardContent className="pt-4">
        <JobTruckLoads {...props} />
      </CardContent>
    </Card>
  );
}
