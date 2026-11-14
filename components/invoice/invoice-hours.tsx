"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Timer, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NO_COST_CENTRE, type RateMode, type RateSource } from "@/lib/approved-hours";
import type { InvoiceHoursView } from "@/lib/invoice-hours";

const SOURCE_LABEL: Record<RateSource, string> = {
  quote: "from the job's quote",
  charge_out: "their charge-out rate",
  company: "company rate",
};

const MODES: { value: RateMode; label: string }[] = [
  { value: "all", label: "One rate for all" },
  { value: "technician", label: "Per technician" },
  { value: "cost_centre", label: "Per cost centre" },
];

/**
 * The job's clocked hours on its invoice, and "Apply hourly rate" (0098 — draft, not applied yet).
 * Lines are built on the server (POST /api/invoices/[id]/hours) and the screen
 * reloads from what was saved — nothing here is reported as done until the
 * server says so.
 */
export function InvoiceHours({ invoiceId, onPricedChange }: { invoiceId: string; onPricedChange?: (unpricedHours: number) => void }) {
  const router = useRouter();
  const [view, setView] = useState<InvoiceHoursView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<RateMode>("all");
  const [all, setAll] = useState("");
  const [byStaff, setByStaff] = useState<Record<string, string>>({});
  const [byCostCentre, setByCostCentre] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);

  async function load() {
    setLoadError(null);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/hours`);
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const v = data as InvoiceHoursView;
      setView(v);
      onPricedChange?.(v.unbilledHours);
      if (v.defaults) {
        setAll(String(v.defaults.all));
        setByStaff(Object.fromEntries(Object.entries(v.defaults.byStaff).map(([k, d]) => [k, String(d.rate)])));
        setByCostCentre(Object.fromEntries(Object.entries(v.defaults.byCostCentre).map(([k, d]) => [k, String(d.rate)])));
      }
    } catch (e: any) {
      setLoadError(e.message ?? "Could not load the job's hours");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId]);

  async function apply() {
    setApplying(true);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/hours`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, all, byStaff, byCostCentre }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `The server refused it (HTTP ${res.status}).`);
      toast.success(`${data.hours.toFixed(2)}h billed on ${data.lines} line${data.lines === 1 ? "" : "s"} — invoice total now $${Number(data.total).toFixed(2)} inc GST`);
      await load();
      router.refresh();
    } catch (e: any) {
      toast.error(e.message ?? "The hours could not be applied");
    }
    setApplying(false);
  }

  if (loadError) {
    return (
      <Card className="border-red-200">
        <CardContent className="py-3 text-sm text-red-700 flex items-center justify-between gap-3">
          <span>Could not load the job&apos;s hours: {loadError}</span>
          <Button size="sm" variant="outline" onClick={load}>Retry</Button>
        </CardContent>
      </Card>
    );
  }
  if (!view) {
    return (
      <Card>
        <CardContent className="py-3 text-sm text-slate-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading the job&apos;s hours…</CardContent>
      </Card>
    );
  }
  if (view.groups.length === 0 && view.billedElsewhereHours === 0) return null;

  const staff = [...new Map(view.groups.map((g) => [g.staffId, g.staffName])).entries()];
  const costCentres = [...new Map(view.groups.map((g) => [g.costCentreKey, g.costCentreName])).entries()];
  const sourceOf = (s: RateSource | undefined) => (s ? SOURCE_LABEL[s] : "");
  const unpriced = view.unbilledHours > 0;

  return (
    <Card className={unpriced ? "border-amber-300" : undefined}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-3 flex-wrap">
          <span className="flex items-center gap-1.5"><Timer className="w-4 h-4" />Hours from the job</span>
          {unpriced ? (
            <span className="text-xs font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />{view.unbilledHours.toFixed(2)}h not priced yet
            </span>
          ) : (
            <span className="text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" />{view.billedHereHours.toFixed(2)}h on this invoice
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {view.groups.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 border-b">
                  <th className="text-left font-medium py-1.5">Cost centre</th>
                  <th className="text-left font-medium py-1.5">Technician</th>
                  <th className="text-right font-medium py-1.5">Hours</th>
                  <th className="text-right font-medium py-1.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {view.groups.map((g) => (
                  <tr key={g.key}>
                    <td className="py-1.5 text-slate-700">{g.costCentreName ?? <span className="text-slate-400">No cost centre</span>}</td>
                    <td className="py-1.5 text-slate-700">{g.staffName}</td>
                    <td className="py-1.5 text-right tabular-nums">{g.hours.toFixed(2)}</td>
                    <td className="py-1.5 text-right text-xs">{g.billedHere ? <span className="text-green-700">On invoice</span> : <span className="text-amber-700">Not priced</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {view.billedElsewhereHours > 0 && (
          <p className="text-xs text-slate-500">{view.billedElsewhereHours.toFixed(2)}h on this job are already billed on another invoice and are not shown here.</p>
        )}

        {view.groups.length > 0 && !view.locked && (
          <div className="space-y-3 border-t pt-3">
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="How to apply the hourly rate">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.value}
                  onClick={() => setMode(m.value)}
                  className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${mode === m.value ? "border-blue-500 bg-blue-50 text-blue-700 font-medium" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {mode === "all" && (
                <RateInput label="All hours" value={all} onChange={setAll} hint={sourceOf(view.defaults?.allSource)} />
              )}
              {mode === "technician" &&
                staff.map(([id, name]) => (
                  <RateInput key={id} label={name} value={byStaff[id] ?? ""} onChange={(v) => setByStaff((p) => ({ ...p, [id]: v }))} hint={sourceOf(view.defaults?.byStaff[id]?.source)} />
                ))}
              {mode === "cost_centre" &&
                costCentres.map(([key, name]) => (
                  <RateInput key={key} label={key === NO_COST_CENTRE ? "No cost centre" : (name ?? "Cost centre")} value={byCostCentre[key] ?? ""} onChange={(v) => setByCostCentre((p) => ({ ...p, [key]: v }))} hint={sourceOf(view.defaults?.byCostCentre[key]?.source)} />
                ))}
            </div>

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-xs text-slate-500">
                Adds one line per cost centre and technician (ex GST). {view.billedHereHours > 0 ? "Replaces the hours lines already on this invoice." : ""}
              </p>
              <Button onClick={apply} disabled={applying} className="gap-2">
                {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Timer className="w-4 h-4" />}
                {applying ? "Applying..." : view.billedHereHours > 0 ? "Re-apply hourly rate" : "Apply hourly rate"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RateInput({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint: string }) {
  return (
    <label className="space-y-1 block">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className="text-sm text-slate-400">$</span>
        <Input type="number" inputMode="decimal" min="0" step="0.01" value={value} onChange={(e) => onChange(e.target.value)} className="h-8 text-sm" />
        <span className="text-xs text-slate-400 whitespace-nowrap">/hr</span>
      </div>
      {hint && <span className="text-[11px] text-slate-400">Default: {hint}</span>}
    </label>
  );
}
