"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { dateKeyInBusinessTZ, formatDate } from "@/lib/date";
import {
  buildMistakeRow,
  CAUSE_MAX,
  DESCRIPTION_MAX,
  formFromMistake,
  loadJobMistakes,
  MISTAKE_COLUMNS,
  mistakesTotal,
  sortMistakes,
  type JobMistake,
  type MistakeForm,
} from "@/lib/job-mistakes";

// Mistake costs on the job (Justin, 23 Nov 2026). On the Purchase Orders tab,
// which office AND admin see (the Costing tab is admin only) and technicians
// never do. Each mistake is logged against one of the job's PO lines; the Job
// Ledger counts it as cost, so it comes off that cost centre's margin.
//
// Writes go from the browser as the caller, like the rest of the PO tab:
// job_mistakes is office/admin only by RLS for every operation (migration
// 0115 — a draft, not applied when this was written; until it is, the card
// says mistakes aren't switched on yet).

interface CostCentreOption {
  id: string;
  name: string;
  po_number?: string | null;
}

interface Props {
  jobId: string;
  costCenters: CostCentreOption[];
  staff: { id: string; full_name: string | null }[];
}

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const emptyForm = (): MistakeForm => ({
  occurred_on: dateKeyInBusinessTZ(new Date()),
  cost_center_id: "",
  amount: "",
  description: "",
  cause: "",
  staff_id: "",
});

const selectClass = "h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700";

export function JobMistakes0115({ jobId, costCenters, staff }: Props) {
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [mistakes, setMistakes] = useState<JobMistake[]>([]);
  // null = form closed; "new" = adding; otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<MistakeForm>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void loadJobMistakes(createClient(), jobId).then((r) => {
      if (!live) return;
      if (r.error) console.error("job mistakes load failed:", r.error);
      setReady(r.ready);
      setLoadError(!!r.error);
      setMistakes(r.mistakes);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [jobId]);

  const centreName = useMemo(() => {
    const m = new Map(costCenters.map((c) => [c.id, c.po_number ? `${c.name} (PO ${c.po_number})` : c.name]));
    return (id: string | null) => (id ? m.get(id) ?? "Cost centre no longer on the job" : "Not tagged");
  }, [costCenters]);
  const staffName = useMemo(() => {
    const m = new Map(staff.map((s) => [s.id, s.full_name ?? "Staff member"]));
    return (id: string | null) => (id ? m.get(id) ?? "Former staff member" : null);
  }, [staff]);

  const total = mistakesTotal(mistakes);

  function openNew() {
    setForm({ ...emptyForm(), cost_center_id: costCenters.length === 1 ? costCenters[0].id : "" });
    setFormError(null);
    setEditing("new");
  }
  function openEdit(m: JobMistake) {
    setForm(formFromMistake(m));
    setFormError(null);
    setEditing(m.id);
  }

  async function save() {
    const built = buildMistakeRow(form, costCenters.map((c) => c.id));
    if (!built.ok) {
      setFormError(built.error);
      return;
    }
    setSaving(true);
    const supabase = createClient();
    const res =
      editing === "new"
        ? await supabase.from("job_mistakes").insert({ ...built.row, job_id: jobId }).select(MISTAKE_COLUMNS).single()
        : await supabase.from("job_mistakes").update(built.row).eq("id", editing!).select(MISTAKE_COLUMNS).single();
    setSaving(false);
    if (res.error || !res.data) {
      console.error("job mistake save failed:", res.error?.message);
      setFormError(res.error?.code === "23514" ? "That cost centre isn't on this job, or the amount isn't above $0." : "Couldn't save the mistake. Try again.");
      return;
    }
    const saved = { ...(res.data as unknown as JobMistake), amount_ex_gst: Number((res.data as { amount_ex_gst: number }).amount_ex_gst) };
    setMistakes((list) => sortMistakes([...list.filter((m) => m.id !== saved.id), saved]));
    setEditing(null);
    toast.success(editing === "new" ? "Mistake logged" : "Mistake updated");
  }

  async function remove(m: JobMistake) {
    if (!window.confirm(`Delete this mistake (${money(m.amount_ex_gst)})? It comes off the job's costs.`)) return;
    setDeletingId(m.id);
    const { error, count } = await createClient().from("job_mistakes").delete({ count: "exact" }).eq("id", m.id);
    setDeletingId(null);
    if (error || count === 0) {
      if (error) console.error("job mistake delete failed:", error.message);
      toast.error("Couldn't delete the mistake.");
      return;
    }
    setMistakes((list) => list.filter((x) => x.id !== m.id));
    if (editing === m.id) setEditing(null);
    toast.success("Mistake deleted");
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Mistakes</CardTitle>
            <p className="text-xs text-slate-500 mt-0.5">
              What mistakes cost this job, by cost centre (ex GST). Counted as cost in the Job Ledger, so they reduce the margin.
              Office only — technicians don&apos;t see this.
            </p>
          </div>
          {ready && !loading && editing === null && (
            <Button size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={openNew}>
              <Plus className="w-3.5 h-3.5" /> Log a mistake
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : !ready ? (
          <p className="text-sm text-slate-500">Mistake costs aren&apos;t switched on yet — the database update for them still has to be applied.</p>
        ) : (
          <>
            {loadError && <p className="text-sm text-red-600">Couldn&apos;t load this job&apos;s mistakes. Refresh to try again.</p>}

            {editing !== null && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="mistake-date">Date</Label>
                    <Input id="mistake-date" type="date" value={form.occurred_on} onChange={(e) => setForm((f) => ({ ...f, occurred_on: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="mistake-centre">Cost centre</Label>
                    <select
                      id="mistake-centre"
                      className={selectClass}
                      value={form.cost_center_id}
                      onChange={(e) => setForm((f) => ({ ...f, cost_center_id: e.target.value }))}
                    >
                      <option value="">Not tagged</option>
                      {costCenters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.po_number ? ` (PO ${c.po_number})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="mistake-amount">Cost (ex GST)</Label>
                    <Input
                      id="mistake-amount"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={form.amount}
                      onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mistake-description">What went wrong</Label>
                  <Textarea
                    id="mistake-description"
                    rows={2}
                    maxLength={DESCRIPTION_MAX}
                    placeholder="e.g. Sewer laid at the wrong fall — dug up and relaid"
                    value={form.description}
                    onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="mistake-cause">Cause (optional)</Label>
                    <Input
                      id="mistake-cause"
                      maxLength={CAUSE_MAX}
                      placeholder="e.g. Wrong plan revision"
                      value={form.cause}
                      onChange={(e) => setForm((f) => ({ ...f, cause: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="mistake-staff">Whose mistake (optional)</Label>
                    <select
                      id="mistake-staff"
                      className={selectClass}
                      value={form.staff_id}
                      onChange={(e) => setForm((f) => ({ ...f, staff_id: e.target.value }))}
                    >
                      <option value="">—</option>
                      {staff.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.full_name ?? "Staff member"}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {costCenters.length === 0 && (
                  <p className="text-xs text-amber-700">This job has no PO cost centres yet, so the mistake will show under &quot;Not tagged&quot;.</p>
                )}
                {formError && <p className="text-sm text-red-600">{formError}</p>}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={saving}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={() => void save()} disabled={saving} className="gap-1.5">
                    {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {editing === "new" ? "Log mistake" : "Save"}
                  </Button>
                </div>
              </div>
            )}

            {mistakes.length === 0 ? (
              !loadError && editing === null && <p className="text-sm text-slate-400">No mistakes logged on this job.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-slate-400 text-left">
                      <th className="font-medium pb-2 pr-3">Date</th>
                      <th className="font-medium pb-2 pr-3">Cost centre</th>
                      <th className="font-medium pb-2 pr-3">What went wrong</th>
                      <th className="font-medium pb-2 pr-3">Whose</th>
                      <th className="font-medium pb-2 pr-3 text-right">Cost</th>
                      <th className="pb-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {mistakes.map((m) => (
                      <tr key={m.id} className="align-top">
                        <td className="py-2 pr-3 whitespace-nowrap text-slate-600">{formatDate(m.occurred_on, { day: "numeric", month: "short", year: "numeric" })}</td>
                        <td className="py-2 pr-3 text-slate-600">{centreName(m.cost_center_id)}</td>
                        <td className="py-2 pr-3 text-slate-800">
                          <span className="whitespace-pre-wrap">{m.description}</span>
                          {m.cause && <span className="block text-xs text-slate-500">Cause: {m.cause}</span>}
                        </td>
                        <td className="py-2 pr-3 text-slate-600">{staffName(m.staff_id) ?? "—"}</td>
                        <td className="py-2 pr-3 text-right font-medium text-red-600 whitespace-nowrap">{money(m.amount_ex_gst)}</td>
                        <td className="py-2 whitespace-nowrap text-right">
                          <button
                            type="button"
                            aria-label="Edit mistake"
                            className="p-1 text-slate-400 hover:text-slate-700"
                            onClick={() => openEdit(m)}
                            disabled={saving}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label="Delete mistake"
                            className="p-1 text-slate-300 hover:text-red-500"
                            onClick={() => void remove(m)}
                            disabled={deletingId === m.id}
                          >
                            {deletingId === m.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-200">
                      <td colSpan={4} className="pt-2 text-xs font-medium text-slate-500">
                        {mistakes.length} mistake{mistakes.length === 1 ? "" : "s"}
                      </td>
                      <td className="pt-2 pr-3 text-right font-semibold text-red-600">{money(total)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
