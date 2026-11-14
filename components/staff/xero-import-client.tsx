"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, Loader2, RefreshCw, Download, AlertTriangle, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { PayField, Preview, PreviewRow } from "@/lib/xero-payroll-import";

const FIELD_LABEL: Record<PayField, string> = {
  hourly_rate: "Hourly rate",
  super_rate: "Super",
  target_hours_per_week: "Hours / week",
  leave_loading_rate: "Leave loading",
};
const fmt = (f: PayField, v: number | null) =>
  v === null ? "—" : f === "hourly_rate" ? `$${v.toFixed(2)}` : f === "target_hours_per_week" ? `${v}h` : `${v}%`;
const HOW_LABEL = { linked: "linked", email: "matched by email", name: "matched by name", manual: "paired by you" } as const;

type Picks = Record<string, { fields: Set<PayField>; leave: boolean }>;

function defaultPicks(rows: PreviewRow[]): Picks {
  return Object.fromEntries(
    rows.map((r) => [r.staffId, { fields: new Set(r.fields.filter((f) => f.changes).map((f) => f.field)), leave: r.leave.newCount > 0 }])
  );
}

/**
 * Staff → Import from Xero (0101 — draft, not applied yet). Reads Xero Payroll,
 * shows it beside the app's values, writes only what's ticked. On demand only.
 */
export function XeroImportClient() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<{ message: string; reconnect: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [since, setSince] = useState("");
  const [pairs, setPairs] = useState<Record<string, string>>({});
  const [picks, setPicks] = useState<Picks>({});
  const [applying, setApplying] = useState(false);

  const load = useCallback(async (sinceArg: string, pairArg: Record<string, string>) => {
    setLoading(true);
    setError(null);
    const q = new URLSearchParams();
    if (sinceArg) q.set("since", sinceArg);
    for (const [e, s] of Object.entries(pairArg)) q.append("pair", `${e}:${s}`);
    try {
      const res = await fetch(`/api/xero/payroll/preview?${q}`);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError({ message: data?.error ?? `HTTP ${res.status}`, reconnect: !!data?.reconnect });
        setPreview(null);
      } else {
        setPreview(data);
        setSince(data.since);
        setPicks(defaultPicks(data.rows));
      }
    } catch {
      setError({ message: "No connection to the server. Try again.", reconnect: false });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load("", {});
  }, [load]);

  const selections = useMemo(
    () =>
      (preview?.rows ?? [])
        .map((r) => ({ r, p: picks[r.staffId] }))
        .filter(({ p }) => p && (p.fields.size > 0 || p.leave))
        .map(({ r, p }) => ({ staffId: r.staffId, xeroEmployeeId: r.xeroEmployeeId, fields: [...p.fields], leave: p.leave })),
    [preview, picks]
  );

  function toggleField(staffId: string, f: PayField) {
    setPicks((all) => {
      const cur = all[staffId] ?? { fields: new Set<PayField>(), leave: false };
      const fields = new Set(cur.fields);
      if (fields.has(f)) fields.delete(f);
      else fields.add(f);
      return { ...all, [staffId]: { ...cur, fields } };
    });
  }

  function pair(xeroEmployeeId: string, staffId: string) {
    const next = { ...pairs };
    if (staffId) next[xeroEmployeeId] = staffId;
    else delete next[xeroEmployeeId];
    setPairs(next);
    load(since, next);
  }

  async function apply() {
    if (!selections.length) return;
    setApplying(true);
    try {
      const res = await fetch("/api/xero/payroll/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ since, selections }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      if (data.people > 0) {
        toast.success(`Imported for ${data.people} ${data.people === 1 ? "person" : "people"}: ${data.fieldsUpdated} pay value${data.fieldsUpdated === 1 ? "" : "s"}, ${data.leaveAdded} leave record${data.leaveAdded === 1 ? "" : "s"}`);
      }
      for (const f of data.failures ?? []) toast.error(`${f.staffName}: ${f.error}`, { duration: 12000 });
      await load(since, pairs);
    } catch (e: any) {
      toast.error(e.message ?? "The import failed.");
    }
    setApplying(false);
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Link prefetch={false} href="/dashboard/staff">
            <Button variant="ghost" size="sm" className="gap-2 text-slate-500"><ArrowLeft className="w-4 h-4" />Staff</Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Import pay &amp; leave from Xero</h1>
            <p className="text-slate-500 text-sm mt-1">Reads Xero Payroll and shows it beside what the app has. Only what you tick is saved.</p>
          </div>
        </div>
        <div className="flex items-end gap-2">
          <label className="space-y-1">
            <span className="block text-xs text-slate-500">Leave from</span>
            <Input type="date" value={since} onChange={(e) => setSince(e.target.value)} className="h-8 w-40 text-sm" />
          </label>
          <Button variant="outline" size="sm" className="gap-2" onClick={() => load(since, pairs)} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />Reload from Xero
          </Button>
        </div>
      </div>

      {loading && !preview && (
        <Card><CardContent className="py-10 flex items-center justify-center gap-2 text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin" />Reading payroll from Xero…</CardContent></Card>
      )}

      {error && (
        <Card className="border-amber-300">
          <CardContent className="py-4 space-y-2 text-sm">
            <p className="flex items-center gap-2 font-medium text-amber-800"><AlertTriangle className="w-4 h-4" />{error.message}</p>
            {error.reconnect && (
              <p className="text-slate-600">
                Go to <Link href="/dashboard/settings" className="text-blue-600 underline">Settings</Link>, disconnect and reconnect Xero, and approve the
                read-only payroll access on Xero&apos;s screen. The app can only read payroll — it can&apos;t change anything in Xero.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {preview && (
        <>
          {preview.rows.length === 0 ? (
            <Card><CardContent className="py-8 text-sm text-slate-500 text-center">No Xero employees matched anyone in the app yet — pair them below.</CardContent></Card>
          ) : (
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-slate-50 text-xs text-slate-500">
                      <th className="text-left font-medium px-4 py-2">Person</th>
                      {(Object.keys(FIELD_LABEL) as PayField[]).map((f) => (
                        <th key={f} className="text-left font-medium px-3 py-2 whitespace-nowrap">{FIELD_LABEL[f]}<span className="block font-normal text-slate-400">app → Xero</span></th>
                      ))}
                      <th className="text-left font-medium px-3 py-2">Leave</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {preview.rows.map((r) => {
                      const p = picks[r.staffId];
                      return (
                        <tr key={r.staffId} className="align-top">
                          <td className="px-4 py-3 min-w-48">
                            <p className="font-medium text-slate-900">{r.staffName}</p>
                            <p className="text-xs text-slate-500 flex items-center gap-1"><Link2 className="w-3 h-3" />{r.xeroName} · {HOW_LABEL[r.how]}</p>
                            <p className="text-[11px] text-slate-400 mt-1">{r.basis}</p>
                            {r.notes.map((n) => <p key={n} className="text-[11px] text-amber-700">{n}</p>)}
                          </td>
                          {r.fields.map((f) => (
                            <td key={f.field} className="px-3 py-3 whitespace-nowrap">
                              {f.xero === null ? (
                                <span className="text-slate-400">{fmt(f.field, f.current)} <span className="text-xs">(not in Xero)</span></span>
                              ) : (
                                <label className={`flex items-center gap-2 ${f.changes ? "" : "text-slate-400"}`}>
                                  <input type="checkbox" className="h-4 w-4" checked={!!p?.fields.has(f.field)} onChange={() => toggleField(r.staffId, f.field)} />
                                  <span>{fmt(f.field, f.current)} → <span className={f.changes ? "font-semibold text-slate-900" : ""}>{fmt(f.field, f.xero)}</span></span>
                                </label>
                              )}
                            </td>
                          ))}
                          <td className="px-3 py-3 whitespace-nowrap">
                            {r.leave.newCount > 0 ? (
                              <label className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4"
                                  checked={!!p?.leave}
                                  onChange={() => setPicks((all) => ({ ...all, [r.staffId]: { ...(all[r.staffId] ?? { fields: new Set() }), leave: !all[r.staffId]?.leave } }))}
                                />
                                <span>{r.leave.newCount} new ({r.leave.newHours}h)</span>
                              </label>
                            ) : (
                              <span className="text-slate-400">Nothing new</span>
                            )}
                            {r.leave.alreadyImported > 0 && <span className="block text-[11px] text-slate-400">{r.leave.alreadyImported} already imported</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {preview.unmatchedEmployees.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Xero employees not matched to anyone ({preview.unmatchedEmployees.length})</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {preview.unmatchedEmployees.map((e) => (
                  <div key={e.xeroEmployeeId} className="flex items-center justify-between gap-3 flex-wrap text-sm">
                    <span>{e.name}{e.email ? <span className="text-slate-400"> · {e.email}</span> : null}</span>
                    <select
                      aria-label={`Pair ${e.name} with a staff member`}
                      value={pairs[e.xeroEmployeeId] ?? ""}
                      onChange={(ev) => pair(e.xeroEmployeeId, ev.target.value)}
                      className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm"
                    >
                      <option value="">Not in the app / skip</option>
                      {preview.unmatchedStaff.map((s) => <option key={s.staffId} value={s.staffId}>{s.name}</option>)}
                    </select>
                  </div>
                ))}
                <p className="text-xs text-slate-400">Pairing someone reloads the comparison. Once imported, the pairing is remembered.</p>
              </CardContent>
            </Card>
          )}

          {preview.unmatchedStaff.length > 0 && (
            <p className="text-xs text-slate-500">
              Not found in Xero Payroll: {preview.unmatchedStaff.map((s) => s.name).join(", ")}. (Subcontractors and staff not paid through Xero won&apos;t appear.)
            </p>
          )}

          <div className="flex items-center justify-between gap-3 flex-wrap border-t pt-4">
            <p className="text-xs text-slate-500">
              Workers comp, fixed yearly costs, trade level and charge-out rate aren&apos;t in Xero and are never changed by this. Leave includes approved leave ending on or after {since}.
            </p>
            <Button onClick={apply} disabled={applying || loading || selections.length === 0} className="gap-2">
              {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {applying ? "Importing…" : `Import for ${selections.length} ${selections.length === 1 ? "person" : "people"}`}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
