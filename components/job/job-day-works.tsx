"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, CheckCircle2, Lock, Pencil, PenLine, Plus, Receipt, RotateCcw, Trash2, Truck, XCircle } from "lucide-react";
import { SignaturePad, type SignaturePadHandle } from "./signature-pad";
import { dateKeyInBusinessTZ, startOfWeekKey, shiftDateKey } from "@/lib/date";
import { dayWorksPeriodLabel, quantityProblem, type HireType, type HireUnit } from "@/lib/hire-pricing";
import { splitMachinesByHire, type DayWorksView, type DayWorksEntry } from "@/lib/day-works-view";
import { buildHireEntryRow } from "@/lib/day-works-entry";
import { TruckLoadsCard, loadSummary, type TruckLoadsLoaded } from "./job-truck-loads";

// The job's Day Works / Hire tab (Stage 1, Nov 2026). Hire and cartage are
// their own lines under the job — never part of the quoted value or a progress
// claim. The crew enter one line per machine per day (quantities only); the
// builder's rep signs it off on screen and it locks; the office sees amounts
// and invoices signed lines weekly or monthly.
//
// Reads come from GET /api/jobs/[id]/hire-entries (names and quantities for
// the crew; amounts only for office/admin). Writes go straight to hire_entries
// under RLS and its guard trigger, which refuse anything the crew may not do.

type Loaded = DayWorksView & { ready: true; isOffice: boolean; userId: string };
type State = { status: "loading" } | { status: "error" } | { status: "not-ready" } | ({ status: "ok" } & Loaded);

interface Draft {
  id: string | null;
  work_date: string;
  equipment_id: string;
  optionKey: string; // "<hire_type>|<hire_unit>"
  hours: string;
  days: string;
  meter_open: string;
  meter_close: string;
  km: string;
  pickup: string;
  dropoff: string;
  description: string;
  attachment_ids: string[];
}

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  signed: "bg-green-100 text-green-800",
  invoiced: "bg-blue-100 text-blue-800",
  void: "bg-red-50 text-red-700 line-through",
};

export function quantityText(e: Pick<DayWorksEntry, "hire_unit" | "hours" | "days" | "meter_open" | "meter_close" | "km" | "pickup" | "dropoff">): string {
  switch (e.hire_unit) {
    case "hour":
      return `${e.hours ?? 0} h`;
    case "day":
      return `${e.days ?? 0} day${e.days === 1 ? "" : "s"}`;
    case "engine_hour":
      return e.meter_open != null && e.meter_close != null
        ? `Meter ${e.meter_open} → ${e.meter_close} (${Math.round((e.meter_close - e.meter_open) * 10) / 10} engine h)`
        : "Meter readings missing";
    case "km":
      return `${e.km ?? 0} km`;
    case "contract":
      return "Contract";
    case "move": {
      const route = [e.pickup, e.dropoff].filter(Boolean).join(" → ");
      return `${route ? `${route} · ` : ""}${e.km ?? 0} km loaded`;
    }
    case "tonne":
    case "m3":
      // Truck-load units (0111, drafted — not applied yet) — never a Day Works entry's.
      return "";
  }
}

function emptyDraft(today: string): Draft {
  return { id: null, work_date: today, equipment_id: "", optionKey: "", hours: "", days: "", meter_open: "", meter_close: "", km: "", pickup: "", dropoff: "", description: "", attachment_ids: [] };
}

interface Props {
  jobId: string;
  readOnly?: boolean;
}

export function JobDayWorks({ jobId, readOnly = false }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const today = dateKeyInBusinessTZ(new Date());
  const [state, setState] = useState<State>({ status: "loading" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [signingId, setSigningId] = useState<string | null>(null);
  // Truck loads (0111): their own section, loaded separately; Invoice Day Works
  // includes the signed extras.
  const [truckLoads, setTruckLoads] = useState<TruckLoadsLoaded | null>(null);
  const [loadsReloadKey, setLoadsReloadKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/hire-entries`);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) return setState({ status: "error" });
      if (!body.ready) return setState({ status: "not-ready" });
      setState({ status: "ok", ...(body as Loaded) });
    } catch {
      setState({ status: "error" });
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") return <div className="p-6 text-sm text-slate-400">Loading…</div>;
  if (state.status === "error")
    return (
      <div className="p-6 text-sm text-red-600">
        Couldn&apos;t load Day Works. <button className="underline" onClick={() => void load()}>Try again</button>
      </div>
    );
  if (state.status === "not-ready")
    return <div className="p-6 text-sm text-slate-500">Day Works isn&apos;t switched on yet — the database update for it still has to be applied.</div>;

  const view = state;
  const machine = (id: string) => view.machines.find((m) => m.id === id);
  // The whole fleet is listed; only machines with a hire rate can take a line.
  const hireReady = splitMachinesByHire(view.machines).ready.length > 0;
  const option = (d: Draft) => {
    const [t, u] = d.optionKey.split("|");
    return machine(d.equipment_id)?.options.find((o) => o.hire_type === t && o.hire_unit === u) ?? null;
  };
  const attachmentName = (id: string) => view.attachments.find((a) => a.id === id)?.name ?? "Attachment";
  const clashFor = (entryId: string) => view.clashes.filter((c) => c.entry_ids.includes(entryId));

  function startNew() {
    setDraft(emptyDraft(today));
    setSigningId(null);
  }

  function startEdit(e: DayWorksEntry) {
    setSigningId(null);
    setDraft({
      id: e.id,
      work_date: e.work_date,
      equipment_id: e.equipment_id,
      optionKey: `${e.hire_type}|${e.hire_unit}`,
      hours: e.hours?.toString() ?? "",
      days: e.days?.toString() ?? "",
      meter_open: e.meter_open?.toString() ?? "",
      meter_close: e.meter_close?.toString() ?? "",
      km: e.km?.toString() ?? "",
      pickup: e.pickup ?? "",
      dropoff: e.dropoff ?? "",
      description: e.description ?? "",
      attachment_ids: e.attachment_ids,
    });
  }

  async function saveDraft() {
    if (!draft) return;
    const [hire_type, hire_unit] = draft.optionKey.split("|") as [HireType, HireUnit];
    // Shared with the phone's API routes (lib/day-works-entry.ts), so both
    // refuse the same things in the same words.
    const built = buildHireEntryRow({ ...draft, hire_type, hire_unit }, option(draft));
    if (!built.ok) return toast.error(built.error);
    const row = { job_id: jobId, ...built.row };
    setSaving(true);
    try {
      const entryId = draft.id ?? crypto.randomUUID();
      if (draft.id) {
        const { error, count } = await supabase.from("hire_entries").update(row, { count: "exact" }).eq("id", draft.id);
        if (error) throw error;
        if (count === 0) throw new Error("This entry is signed or no longer yours to change. Refresh to see it.");
        const before = view.entries.find((e) => e.id === draft.id)?.attachment_ids ?? [];
        const removed = before.filter((a) => !draft.attachment_ids.includes(a));
        const added = draft.attachment_ids.filter((a) => !before.includes(a));
        if (removed.length > 0) {
          const { error: delErr } = await supabase.from("hire_entry_attachments").delete().eq("entry_id", entryId).in("attachment_id", removed);
          if (delErr) throw delErr;
        }
        if (added.length > 0) {
          const { error: addErr } = await supabase.from("hire_entry_attachments").insert(added.map((attachment_id) => ({ entry_id: entryId, attachment_id })));
          if (addErr) throw addErr;
        }
      } else {
        const { error } = await supabase.from("hire_entries").insert({ id: entryId, ...row });
        if (error) throw error;
        if (draft.attachment_ids.length > 0) {
          const { error: addErr } = await supabase
            .from("hire_entry_attachments")
            .insert(draft.attachment_ids.map((attachment_id) => ({ entry_id: entryId, attachment_id })));
          if (addErr) {
            toast.error("The entry was saved but its attachments were not. Edit it and tick them again.");
            setDraft(null);
            await load();
            return;
          }
        }
      }
      toast.success(draft.id ? "Day Works entry updated" : "Day Works entry added");
      setDraft(null);
      await load();
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "23505") toast.error("This machine already has a Day Works line for that day on this job. Edit that one instead.");
      else if (e.code === "42501") toast.error("You can only add Day Works on jobs you're on.");
      else toast.error(e.message || "Couldn't save the entry. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function removeDraft(e: DayWorksEntry) {
    if (!window.confirm(`Delete the ${e.equipment} entry for ${fmtDate(e.work_date)}?`)) return;
    const { error, count } = await supabase.from("hire_entries").delete({ count: "exact" }).eq("id", e.id).eq("status", "draft");
    if (error || count === 0) return toast.error("Couldn't delete it — only unsigned entries can be deleted.");
    toast.success("Entry deleted");
    await load();
  }

  async function voidEntry(e: DayWorksEntry) {
    const reason = window.prompt(`Void the signed ${e.equipment} entry for ${fmtDate(e.work_date)}? Say why:`);
    if (reason === null) return;
    // Through the office-only route (shared with the phone): RLS + 0108's guard decide.
    const res = await fetch(`/api/jobs/${jobId}/hire-entries/${e.id}/void`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok) return toast.error(body?.error ?? "Couldn't void it.");
    toast.success("Entry voided");
    await load();
  }

  const entriesByDate = new Map<string, DayWorksEntry[]>();
  for (const e of view.entries) (entriesByDate.get(e.work_date) ?? entriesByDate.set(e.work_date, []).get(e.work_date)!).push(e);

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Day Works / Hire</h2>
          <p className="text-sm text-slate-500">
            Plant hire and cartage, one line per machine per day. Charged separately from the quoted work and progress claims.
            {!view.isOffice && " Hours and quantities only."}
          </p>
        </div>
        {!readOnly && !draft && (
          <Button className="gap-2 shrink-0" onClick={startNew} disabled={!hireReady}>
            <Plus className="w-4 h-4" />Add Day Works
          </Button>
        )}
      </div>

      {view.machines.length === 0 ? (
        <p className="text-sm text-amber-700">
          There are no machines in the fleet register yet.{view.isOffice ? <> Add them in <Link prefetch={false} href="/dashboard/fleet" className="underline">Fleet</Link>.</> : " Ask the office to add them."}
        </p>
      ) : !hireReady ? (
        <p className="text-sm text-amber-700">
          No machine in the fleet has a hire rate yet.
          {view.isOffice ? <> <Link prefetch={false} href="/dashboard/fleet#hire-rates" className="underline">Set rates in Fleet → Hire rates</Link>.</> : " Ask the office to set them up in Fleet."}
        </p>
      ) : (
        view.isOffice &&
        (() => {
          const missing = splitMachinesByHire(view.machines).noRate.length;
          return missing > 0 ? (
            <p className="text-sm text-amber-700">
              {missing === 1 ? "1 machine has" : `${missing} machines have`} no hire rate yet and can&apos;t be picked.{" "}
              <Link prefetch={false} href="/dashboard/fleet#hire-rates" className="underline">Set rates in Fleet → Hire rates</Link>.
            </p>
          ) : null;
        })()
      )}

      {view.clashes.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 space-y-1" role="alert">
          {view.clashes.map((c) => (
            <p key={`${c.attachment}-${c.work_date}`} className="flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {c.attachment} is ticked on {c.machines.length} machines on {fmtDate(c.work_date)}: {c.machines.join(", ")}. It can only be on one — check which is right so it isn&apos;t charged twice.
              </span>
            </p>
          ))}
        </div>
      )}

      {view.pricing && view.pricing.byCostCentre.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Day Works by cost centre (ex GST, not void)</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            {view.pricing.byCostCentre.map((c) => (
              <div key={c.name} className="flex justify-between">
                <span>{c.name} <span className="text-slate-400">· {c.entries} line{c.entries === 1 ? "" : "s"}</span>{c.unpriced > 0 && <span className="text-amber-700"> · {c.unpriced} with no rate set</span>}</span>
                <span className="font-medium tabular-nums">{money(c.amount)}</span>
              </div>
            ))}
            <div className="flex justify-between border-t pt-1 text-slate-600">
              <span>Signed, not yet invoiced</span>
              <span className="font-medium tabular-nums">{money(view.pricing.uninvoicedSigned)}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {draft && (
        <EntryForm
          draft={draft}
          setDraft={setDraft}
          view={view}
          saving={saving}
          onSave={() => void saveDraft()}
          onCancel={() => setDraft(null)}
        />
      )}

      {view.entries.length === 0 && !draft ? (
        <div className="flex flex-col items-center justify-center py-12 text-slate-400">
          <Truck className="w-10 h-10 mb-2 opacity-40" />
          <p className="text-sm">No Day Works on this job yet</p>
        </div>
      ) : (
        <div className="space-y-5">
          {[...entriesByDate.entries()].map(([date, list]) => (
            <div key={date} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{fmtDate(date)}</h3>
              {list.map((e) => {
                const price = view.pricing?.entries[e.id];
                const clashes = clashFor(e.id);
                return (
                  <Card key={e.id} className={e.status === "void" ? "opacity-60" : ""}>
                    <CardContent className="p-4 space-y-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium text-sm text-slate-900">
                            {e.equipment} <span className="text-slate-500 font-normal">· {e.hire_label}</span>
                          </p>
                          <p className="text-sm text-slate-700">{quantityText(e)}</p>
                          {e.attachment_ids.length > 0 && (
                            <p className="text-xs text-slate-500">
                              With: {e.attachment_ids.map(attachmentName).join(", ")}
                              {clashes.length > 0 && <span className="text-amber-700"> · also ticked on another machine that day</span>}
                            </p>
                          )}
                          {e.description && <p className="text-sm text-slate-600 whitespace-pre-wrap mt-1">{e.description}</p>}
                          <p className="text-xs text-slate-400 mt-1">
                            {e.cost_centre ?? "No cost centre"}
                            {e.created_by_name ? ` · entered by ${e.created_by_name}` : ""}
                          </p>
                        </div>
                        <div className="text-right space-y-1">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${STATUS_STYLE[e.status] ?? ""}`}>{e.status}</span>
                          {price && (
                            <p className="text-sm font-medium tabular-nums">
                              {price.total === null ? <span className="text-amber-700">No rate set</span> : money(price.total)}
                            </p>
                          )}
                        </div>
                      </div>

                      {e.status !== "draft" && e.signer_name && (
                        <div className="flex items-center gap-3 rounded-md bg-slate-50 p-2 text-xs text-slate-600">
                          <Lock className="w-3.5 h-3.5 shrink-0" />
                          <span>
                            Signed by {e.signer_name}
                            {e.signed_at ? ` on ${new Date(e.signed_at).toLocaleString("en-AU", { timeZone: "Australia/Melbourne", dateStyle: "medium", timeStyle: "short" })}` : ""}. Locked.
                          </span>
                          {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL */}
                          {e.signature_url && <img src={e.signature_url} alt={`Signature of ${e.signer_name}`} className="h-10 ml-auto bg-white rounded border" />}
                        </div>
                      )}
                      {e.status === "void" && e.void_reason && <p className="text-xs text-red-700">Void: {e.void_reason}</p>}
                      {e.status === "invoiced" && view.isOffice && e.invoice_id && (
                        <a href={`/dashboard/invoices/${e.invoice_id}`} className="text-xs text-blue-600 underline">Open the invoice</a>
                      )}

                      {!readOnly && e.status === "draft" && signingId !== e.id && (
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button size="sm" className="gap-1.5" onClick={() => { setDraft(null); setSigningId(e.id); }}>
                            <PenLine className="w-3.5 h-3.5" />Builder sign-off
                          </Button>
                          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => startEdit(e)}>
                            <Pencil className="w-3.5 h-3.5" />Edit
                          </Button>
                          <Button size="sm" variant="ghost" className="gap-1.5 text-slate-500 hover:text-red-600" onClick={() => void removeDraft(e)}>
                            <Trash2 className="w-3.5 h-3.5" />Delete
                          </Button>
                        </div>
                      )}
                      {view.isOffice && e.status === "signed" && (
                        <div className="pt-1">
                          <Button size="sm" variant="ghost" className="gap-1.5 text-slate-500 hover:text-red-600" onClick={() => void voidEntry(e)}>
                            <XCircle className="w-3.5 h-3.5" />Void
                          </Button>
                        </div>
                      )}
                      {signingId === e.id && (
                        <SignOff
                          jobId={jobId}
                          entry={e}
                          onDone={async () => { setSigningId(null); await load(); }}
                          onCancel={() => setSigningId(null)}
                        />
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <TruckLoadsCard jobId={jobId} readOnly={readOnly} onLoaded={setTruckLoads} reloadKey={loadsReloadKey} />

      {view.isOffice && !readOnly && (
        <InvoiceDayWorks
          jobId={jobId}
          entries={view.entries}
          pricing={view.pricing}
          truckLoads={truckLoads}
          today={today}
          onInvoiced={(invoiceId) => {
            setLoadsReloadKey((k) => k + 1);
            router.push(`/dashboard/invoices/${invoiceId}`);
          }}
        />
      )}
    </div>
  );
}

function EntryForm({ draft, setDraft, view, saving, onSave, onCancel }: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  view: Loaded;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const m = view.machines.find((x) => x.id === draft.equipment_id);
  // Machines with no hire rate are listed greyed out (the server refuses a line for them anyway).
  const { ready, noRate } = splitMachinesByHire(view.machines);
  const [t, u] = draft.optionKey.split("|") as [HireType | "", HireUnit | ""];
  const opt = m?.options.find((o) => o.hire_type === t && o.hire_unit === u) ?? null;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const pickMachine = (id: string) => {
    const next = view.machines.find((x) => x.id === id);
    const only = next?.options.length === 1 ? `${next.options[0].hire_type}|${next.options[0].hire_unit}` : "";
    set({ equipment_id: id, optionKey: only });
  };
  const problem = opt
    ? quantityProblem({
        hire_unit: opt.hire_unit,
        hours: numOrNull(draft.hours),
        days: numOrNull(draft.days),
        meter_open: draft.meter_open === "" ? null : Number(draft.meter_open),
        meter_close: draft.meter_close === "" ? null : Number(draft.meter_close),
        km: draft.km === "" ? null : Number(draft.km),
      })
    : null;

  return (
    <Card className="border-blue-200">
      <CardHeader className="pb-2"><CardTitle className="text-sm">{draft.id ? "Edit Day Works entry" : "Add Day Works entry"}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Date</Label>
            <Input type="date" value={draft.work_date} onChange={(e) => set({ work_date: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Machine</Label>
            <Select value={draft.equipment_id || null} onValueChange={(v) => pickMachine((v as string) ?? "")}>
              <SelectTrigger><SelectValue placeholder="Pick from the fleet register" /></SelectTrigger>
              <SelectContent>
                {ready.map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}
                {noRate.length > 0 && (
                  <SelectGroup>
                    <SelectLabel className="text-xs text-amber-700">No hire rate yet — office to set up in Fleet</SelectLabel>
                    {noRate.map((x) => (
                      <SelectItem key={x.id} value={x.id} disabled>{x.name}</SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
            {m && m.options.length === 0 && (
              <p className="text-xs text-amber-700">
                {m.name} has no hire rate yet.{" "}
                {view.isOffice ? <Link prefetch={false} href="/dashboard/fleet#hire-rates" className="underline">Set it up in Fleet → Hire rates</Link> : "Ask the office to set it up in Fleet."}
              </p>
            )}
          </div>
          {m && m.options.length > 1 && (
            <div className="space-y-1.5">
              <Label>Hired as</Label>
              <Select value={draft.optionKey || null} onValueChange={(v) => set({ optionKey: (v as string) ?? "" })}>
                <SelectTrigger><SelectValue placeholder="Wet or dry?" /></SelectTrigger>
                <SelectContent>
                  {m.options.map((o) => <SelectItem key={`${o.hire_type}|${o.hire_unit}`} value={`${o.hire_type}|${o.hire_unit}`}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {opt && (
          <>
            <p className="text-xs text-slate-500">
              {opt.label}
              {opt.fuel_included ? " · fuel included" : opt.hire_type === "dry" ? " · hirer supplies fuel" : ""}
              {opt.whole_days_only ? " · full days only" : ""}. The cost centre comes from the fleet register.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {opt.hire_unit === "hour" && (
                <div className="space-y-1.5">
                  <Label>Hours</Label>
                  <Input type="number" inputMode="decimal" min={0} max={24} step={0.25} value={draft.hours} onChange={(e) => set({ hours: e.target.value })} />
                </div>
              )}
              {opt.hire_unit === "day" && (
                <div className="space-y-1.5">
                  <Label>Days</Label>
                  <Input type="number" inputMode="decimal" min={0} step={opt.whole_days_only ? 1 : 0.5} value={draft.days} onChange={(e) => set({ days: e.target.value })} />
                </div>
              )}
              {opt.hire_unit === "engine_hour" && (
                <>
                  <div className="space-y-1.5">
                    <Label>Meter opening</Label>
                    <Input type="number" inputMode="decimal" min={0} step={0.1} value={draft.meter_open} onChange={(e) => set({ meter_open: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Meter closing</Label>
                    <Input type="number" inputMode="decimal" min={0} step={0.1} value={draft.meter_close} onChange={(e) => set({ meter_close: e.target.value })} />
                  </div>
                </>
              )}
              {(opt.hire_unit === "km" || opt.hire_unit === "move") && (
                <div className="space-y-1.5">
                  <Label>{opt.hire_unit === "move" ? "Loaded km" : "Km"}</Label>
                  <Input type="number" inputMode="decimal" min={0} step={1} value={draft.km} onChange={(e) => set({ km: e.target.value })} />
                </div>
              )}
              {(opt.hire_unit === "move" || opt.hire_type === "cartage") && (
                <>
                  <div className="space-y-1.5">
                    <Label>From</Label>
                    <Input value={draft.pickup} onChange={(e) => set({ pickup: e.target.value })} placeholder="Pick-up" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>To</Label>
                    <Input value={draft.dropoff} onChange={(e) => set({ dropoff: e.target.value })} placeholder="Drop-off" />
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {view.attachments.length > 0 && opt && opt.hire_type !== "float" && (
          <div className="space-y-1.5">
            <Label>Attachments on the machine (a full day each)</Label>
            <div className="flex flex-wrap gap-3">
              {view.attachments.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.attachment_ids.includes(a.id)}
                    onChange={(e) =>
                      set({ attachment_ids: e.target.checked ? [...draft.attachment_ids, a.id] : draft.attachment_ids.filter((x) => x !== a.id) })
                    }
                  />
                  {a.name}
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <Label>Description of the works</Label>
          <Textarea value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="What the machine did today" rows={3} />
        </div>

        {problem && <p className="text-xs text-slate-500">Before sign-off: {problem}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SignOff({ jobId, entry, onDone, onCancel }: { jobId: string; entry: DayWorksEntry; onDone: () => Promise<void>; onCancel: () => void }) {
  const supabase = useMemo(() => createClient(), []);
  const padRef = useRef<SignaturePadHandle>(null);
  const [name, setName] = useState("");
  const [hasSignature, setHasSignature] = useState(false);
  const [saving, setSaving] = useState(false);
  const problem = quantityProblem(entry);

  async function sign() {
    if (problem) return toast.error(problem + " Edit the entry first.");
    if (!name.trim()) return toast.error("Enter the name of the builder's representative.");
    if (!hasSignature || !padRef.current) return toast.error("Ask them to sign in the box.");
    setSaving(true);
    try {
      const blob = await padRef.current.toBlob();
      if (!blob) throw new Error("The signature couldn't be read. Clear it and sign again.");
      // Same bucket and job folder as the job's other documents; the path
      // carries no "expense"/"variations" segment, so the crew can read it.
      const path = `${jobId}/day-works/signature-${entry.id}-${Date.now()}.png`;
      const { error: upErr } = await supabase.storage.from("job-documents").upload(path, blob, { contentType: "image/png" });
      if (upErr) throw new Error("The signature didn't upload. Check the connection and try again.");
      const { error, count } = await supabase
        .from("hire_entries")
        .update({ status: "signed", signer_name: name.trim(), signature_path: path }, { count: "exact" })
        .eq("id", entry.id)
        .eq("status", "draft");
      if (error) throw error;
      if (count === 0) throw new Error("This entry was already signed or removed. Refresh to see it.");
      toast.success("Signed off and locked");
      await onDone();
    } catch (err) {
      toast.error((err as { message?: string }).message || "Couldn't save the sign-off. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 space-y-3 rounded-md border border-blue-200 bg-blue-50/40 p-3">
      <p className="text-sm font-medium text-slate-900">Builder&apos;s representative sign-off</p>
      <p className="text-xs text-slate-600">
        {entry.equipment} · {quantityText(entry)}{entry.description ? ` · ${entry.description}` : ""}. Once signed, this line is locked and can&apos;t be edited.
      </p>
      {problem && <p className="text-xs text-amber-700">{problem} Edit the entry before it&apos;s signed.</p>}
      <div className="space-y-1.5">
        <Label>Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam Builder (site supervisor)" />
      </div>
      <SignaturePad ref={padRef} onChange={setHasSignature} />
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => padRef.current?.clear()}>
          <RotateCcw className="w-3.5 h-3.5" />Clear
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" className="gap-1.5 flex-1" onClick={() => void sign()} disabled={saving || !hasSignature || !!problem}>
          <CheckCircle2 className="w-3.5 h-3.5" />{saving ? "Saving…" : "Sign & lock"}
        </Button>
      </div>
    </div>
  );
}

function InvoiceDayWorks({ jobId, entries, pricing, truckLoads, today, onInvoiced }: {
  jobId: string;
  entries: DayWorksEntry[];
  pricing: DayWorksView["pricing"];
  /** Truck loads (0111): signed extras go on the same invoice. Null before 0111 or while loading. */
  truckLoads: TruckLoadsLoaded | null;
  today: string;
  onInvoiced: (invoiceId: string) => void;
}) {
  // Default: last week, Monday to Sunday.
  const lastMonday = shiftDateKey(startOfWeekKey(today), -7);
  const [from, setFrom] = useState(lastMonday);
  const [to, setTo] = useState(shiftDateKey(lastMonday, 6));
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const waiting = entries.filter((e) => e.status === "signed" && !e.invoice_id);
  const inRange = waiting.filter((e) => e.work_date >= from && e.work_date <= to).sort((a, b) => a.work_date.localeCompare(b.work_date));
  const picked = inRange.filter((e) => !excluded.has(e.id));
  const unpriced = picked.filter((e) => pricing?.entries[e.id]?.total == null);
  const loadPrice = (id: string) => truckLoads?.pricing?.loads[id]?.total ?? null;
  const waitingLoads = (truckLoads?.loads ?? []).filter((l) => l.status === "signed" && l.billing === "extra" && !l.invoice_id);
  const loadsInRange = waitingLoads.filter((l) => l.load_date >= from && l.load_date <= to).sort((a, b) => a.load_date.localeCompare(b.load_date));
  const pickedLoads = loadsInRange.filter((l) => !excluded.has(l.id));
  const unpricedLoads = pickedLoads.filter((l) => loadPrice(l.id) == null);
  const total =
    picked.reduce((s, e) => s + (pricing?.entries[e.id]?.total ?? 0), 0) + pickedLoads.reduce((s, l) => s + (loadPrice(l.id) ?? 0), 0);
  const allWaitingDates = [...waiting.map((e) => e.work_date), ...waitingLoads.map((l) => l.load_date)].sort();

  async function create() {
    if (picked.length + pickedLoads.length === 0) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/hire-entries/invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryIds: picked.map((e) => e.id), loadIds: pickedLoads.map((l) => l.id), from, to }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return toast.error(body.error ?? "Couldn't make the invoice.");
      toast.success(`Invoice ${body.invoiceNumber ?? ""} created — check it, then send it.`);
      onInvoiced(body.invoiceId);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2"><Receipt className="w-4 h-4" />Invoice Day Works</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-slate-500">
          Signed lines and signed extra truck loads not yet invoiced go on their own invoice, separate from the quoted work and progress claims. {waiting.length + waitingLoads.length} waiting in all.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label>From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex gap-2 pb-0.5">
            <Button variant="outline" size="sm" onClick={() => { setFrom(lastMonday); setTo(shiftDateKey(lastMonday, 6)); }}>Last week</Button>
            <Button variant="outline" size="sm" onClick={() => { const [y, m] = today.split("-").map(Number); const pm = m === 1 ? 12 : m - 1; const py = m === 1 ? y - 1 : y; setFrom(`${py}-${String(pm).padStart(2, "0")}-01`); setTo(shiftDateKey(`${y}-${String(m).padStart(2, "0")}-01`, -1)); }}>Last month</Button>
            {allWaitingDates.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => { setFrom(allWaitingDates[0]); setTo(allWaitingDates[allWaitingDates.length - 1]); }}>All waiting</Button>
            )}
          </div>
        </div>
        {inRange.length === 0 && loadsInRange.length === 0 ? (
          <p className="text-slate-500">No signed, un-invoiced lines between {dayWorksPeriodLabel(from, to)}.</p>
        ) : (
          <div className="divide-y rounded-md border">
            {inRange.map((e) => (
              <label key={e.id} className="flex items-center gap-3 px-3 py-2">
                <input
                  type="checkbox"
                  checked={!excluded.has(e.id)}
                  onChange={(ev) => setExcluded((s) => { const n = new Set(s); if (ev.target.checked) n.delete(e.id); else n.add(e.id); return n; })}
                />
                <span className="flex-1 min-w-0">{fmtDate(e.work_date)} · {e.equipment} · {quantityText(e)}</span>
                <span className="tabular-nums">{pricing?.entries[e.id]?.total == null ? <span className="text-amber-700">No rate</span> : money(pricing.entries[e.id].total!)}</span>
              </label>
            ))}
            {loadsInRange.map((l) => (
              <label key={l.id} className="flex items-center gap-3 px-3 py-2">
                <input
                  type="checkbox"
                  checked={!excluded.has(l.id)}
                  onChange={(ev) => setExcluded((s) => { const n = new Set(s); if (ev.target.checked) n.delete(l.id); else n.add(l.id); return n; })}
                />
                <span className="flex-1 min-w-0">{fmtDate(l.load_date)} · {l.truck} · {loadSummary(l, truckLoads?.siteLabel ?? null)}</span>
                <span className="tabular-nums">{loadPrice(l.id) == null ? <span className="text-amber-700">Not priced</span> : money(loadPrice(l.id)!)}</span>
              </label>
            ))}
          </div>
        )}
        {unpriced.length > 0 && <p className="text-xs text-amber-700">{unpriced.length} ticked line(s) have no hire rate. Set them up in Fleet → Hire setup first.</p>}
        {unpricedLoads.length > 0 && <p className="text-xs text-amber-700">{unpricedLoads.length} ticked truck load(s) can&apos;t be priced yet — enter the docket cost, or the truck&apos;s rates in Fleet → Hire setup (see Truck loads above).</p>}
        <div className="flex items-center justify-between">
          <span className="text-slate-600">{picked.length + pickedLoads.length} line{picked.length + pickedLoads.length === 1 ? "" : "s"} · {money(total)} ex GST</span>
          <Button onClick={() => void create()} disabled={busy || picked.length + pickedLoads.length === 0 || unpriced.length > 0 || unpricedLoads.length > 0} className="gap-1.5">
            <Receipt className="w-4 h-4" />{busy ? "Creating…" : "Create invoice"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
