"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Wrench, Plus, Trash2, Gauge, CalendarClock, AlertTriangle, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/date";
import {
  SERVICE_TYPE_EXPENSE_CATEGORY,
  SERVICE_TYPE_LABELS,
  dueLabel,
  serviceDue,
  sortRecords,
  type ServiceRecord,
} from "@/lib/service-due";

const NEW_EXPENSE = "__new__";
const NO_EXPENSE = "";

const blankForm = (today: string) => ({
  service_date: today,
  service_type: "scheduled",
  odometer_km: "",
  engine_hours: "",
  provider: "",
  work_done: "",
  next_due_date: "",
  next_due_km: "",
  next_due_hours: "",
  expense: NO_EXPENSE,
  amount: "",
  gst_amount: "",
  invoice_number: "",
});

const num = (v: string) => (v.trim() === "" ? null : Number(v));

/**
 * Service history for one fleet item (0099 — draft, not applied yet): readings,
 * what was done, the next one due, and the invoice it was paid on. The cost
 * itself is an equipment_expenses row (new or existing), so the yearly summary
 * and the actual cost rate count it once.
 */
export function EquipmentServiceRecords({
  equipmentId,
  records,
  onRecordsChange,
  expenses,
  onExpenseCreated,
  canEdit,
  currentUserId,
  today,
}: {
  equipmentId: string;
  /** null = the table is not in this database yet (0099 unapplied). */
  records: ServiceRecord[] | null;
  onRecordsChange: (r: ServiceRecord[]) => void;
  expenses: any[];
  onExpenseCreated: (e: any) => void;
  canEdit: boolean;
  currentUserId: string;
  today: string;
}) {
  const supabase = createClient();
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => blankForm(today));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const sorted = useMemo(() => sortRecords(records ?? []), [records]);
  const due = useMemo(() => serviceDue(records ?? [], today), [records, today]);
  const linked = new Set((records ?? []).map((r) => r.expense_id).filter(Boolean));
  const linkable = expenses.filter((e) => !linked.has(e.id));
  const expenseById = new Map(expenses.map((e) => [e.id, e]));

  if (records === null) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="py-6 text-sm text-slate-500">
            Service records aren&apos;t switched on in this database yet (migration 0099). Expenses and receipts still work in the Expenses &amp; Service tab.
          </CardContent>
        </Card>
      </div>
    );
  }

  function set(field: keyof ReturnType<typeof blankForm>, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: "" }));
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!form.service_date) e.service_date = "Enter the service date";
    for (const f of ["odometer_km", "engine_hours", "next_due_km", "next_due_hours"] as const) {
      const v = num(form[f]);
      if (v !== null && (!Number.isFinite(v) || v < 0)) e[f] = "Must be a number, zero or more";
    }
    if (form.next_due_date && form.next_due_date <= form.service_date) e.next_due_date = "Must be after the service date";
    const km = num(form.odometer_km);
    const dueKm = num(form.next_due_km);
    if (km !== null && dueKm !== null && dueKm <= km) e.next_due_km = "Must be above this service's odometer";
    if (form.expense === NEW_EXPENSE && !(Number(form.amount) > 0)) e.amount = "Enter the amount ex GST";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function save() {
    if (!validate()) return;
    setSaving(true);

    // 1. The cost, if it's new. Created first so the service can point at it.
    let expenseId: string | null = form.expense && form.expense !== NEW_EXPENSE ? form.expense : null;
    let createdExpense: any = null;
    if (form.expense === NEW_EXPENSE) {
      const { data, error } = await supabase
        .from("equipment_expenses")
        .insert({
          equipment_id: equipmentId,
          category: SERVICE_TYPE_EXPENSE_CATEGORY[form.service_type] ?? "service",
          supplier_name: form.provider.trim() || null,
          description: form.work_done.trim() || SERVICE_TYPE_LABELS[form.service_type],
          invoice_number: form.invoice_number.trim() || null,
          expense_date: form.service_date,
          amount: Number(form.amount) || 0,
          gst_amount: Number(form.gst_amount) || 0,
          logged_by: currentUserId,
        })
        .select()
        .single();
      if (error || !data) {
        toast.error(`The cost could not be saved (${error?.message ?? "no row returned"}). Nothing was saved.`);
        setSaving(false);
        return;
      }
      createdExpense = data;
      expenseId = data.id;
    }

    // 2. The service.
    const { data: record, error: recErr } = await supabase
      .from("equipment_service_records")
      .insert({
        equipment_id: equipmentId,
        service_date: form.service_date,
        service_type: form.service_type,
        odometer_km: num(form.odometer_km),
        engine_hours: num(form.engine_hours),
        provider: form.provider.trim() || null,
        work_done: form.work_done.trim() || null,
        expense_id: expenseId,
        next_due_date: form.next_due_date || null,
        next_due_km: num(form.next_due_km),
        next_due_hours: num(form.next_due_hours),
      })
      .select()
      .single();

    if (recErr || !record) {
      // Undo the cost we just created, so a failed service never leaves an
      // orphan expense counted in the yearly total.
      let note = "";
      if (createdExpense) {
        const { error: undoErr } = await supabase.from("equipment_expenses").delete().eq("id", createdExpense.id);
        note = undoErr
          ? ` The cost was saved but could not be removed again (${undoErr.message}) — delete it from Expenses & Service.`
          : " The cost entered with it was not kept.";
      }
      toast.error(`The service could not be saved (${recErr?.message ?? "no row returned"}).${note}`);
      setSaving(false);
      return;
    }

    if (createdExpense) onExpenseCreated(createdExpense);
    onRecordsChange([record as unknown as ServiceRecord, ...(records ?? [])]);
    toast.success(createdExpense ? "Service and its cost saved" : "Service saved");
    setForm(blankForm(today));
    setShowForm(false);
    setSaving(false);
  }

  async function remove(r: ServiceRecord) {
    if (!window.confirm(`Delete the ${formatDate(r.service_date)} service record? Its cost (if any) stays in Expenses & Service.`)) return;
    const { error, count } = await supabase.from("equipment_service_records").delete({ count: "exact" }).eq("id", r.id);
    if (error || count === 0) {
      toast.error(error?.message ?? "The service record could not be deleted.");
      return;
    }
    onRecordsChange((records ?? []).filter((x) => x.id !== r.id));
    toast.success("Service record deleted");
  }

  const dueTone =
    due.state === "overdue" ? "border-red-200 bg-red-50 text-red-800"
      : due.state === "due_soon" ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-slate-200 bg-white text-slate-700";

  return (
    <div className="p-6 space-y-4">
      <div className={`rounded-lg border px-4 py-3 text-sm flex flex-wrap items-center gap-x-6 gap-y-1 ${dueTone}`}>
        <span className="font-semibold flex items-center gap-1.5">
          {due.state === "overdue" ? <AlertTriangle className="w-4 h-4" /> : <CalendarClock className="w-4 h-4" />}
          {dueLabel(due)}{due.dueDate ? ` (${formatDate(due.dueDate)})` : ""}
        </span>
        {due.dueKm != null && <span>Due at {due.dueKm.toLocaleString("en-AU")} km{due.lastKm != null ? ` · last recorded ${due.lastKm.toLocaleString("en-AU")} km` : ""}</span>}
        {due.dueHours != null && <span>Due at {due.dueHours.toLocaleString("en-AU")} h{due.lastHours != null ? ` · last recorded ${due.lastHours.toLocaleString("en-AU")} h` : ""}</span>}
      </div>

      {canEdit && !showForm && (
        <Button variant="outline" className="gap-2" onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4" />Log a service
        </Button>
      )}

      {showForm && (
        <Card>
          <CardHeader><CardTitle className="text-base">Log a service</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Date *" error={errors.service_date}>
                <Input type="date" value={form.service_date} onChange={(e) => set("service_date", e.target.value)} />
              </Field>
              <Field label="Type">
                <select value={form.service_type} onChange={(e) => set("service_type", e.target.value)} className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm">
                  {Object.entries(SERVICE_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <Field label="Done by">
                <Input value={form.provider} onChange={(e) => set("provider", e.target.value)} placeholder="Workshop or mechanic" />
              </Field>
              <Field label="Odometer (km)" error={errors.odometer_km}>
                <Input inputMode="numeric" value={form.odometer_km} onChange={(e) => set("odometer_km", e.target.value)} placeholder="e.g. 84210" />
              </Field>
              <Field label="Engine hours" error={errors.engine_hours}>
                <Input inputMode="decimal" value={form.engine_hours} onChange={(e) => set("engine_hours", e.target.value)} placeholder="Plant only" />
              </Field>
            </div>
            <Field label="Work done">
              <Textarea rows={2} value={form.work_done} onChange={(e) => set("work_done", e.target.value)} placeholder="e.g. Oil and filters, front pads, wiper blades" />
            </Field>

            <div>
              <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">Next service due</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Field label="Date" error={errors.next_due_date}>
                  <Input type="date" value={form.next_due_date} onChange={(e) => set("next_due_date", e.target.value)} />
                </Field>
                <Field label="Odometer (km)" error={errors.next_due_km}>
                  <Input inputMode="numeric" value={form.next_due_km} onChange={(e) => set("next_due_km", e.target.value)} placeholder="e.g. 94210" />
                </Field>
                <Field label="Engine hours" error={errors.next_due_hours}>
                  <Input inputMode="decimal" value={form.next_due_hours} onChange={(e) => set("next_due_hours", e.target.value)} />
                </Field>
              </div>
            </div>

            <div className="space-y-3 border-t pt-3">
              <Field label="Invoice for this service">
                <select value={form.expense} onChange={(e) => set("expense", e.target.value)} className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm">
                  <option value={NO_EXPENSE}>No cost / not invoiced yet</option>
                  <option value={NEW_EXPENSE}>Log the cost now…</option>
                  {linkable.map((e) => (
                    <option key={e.id} value={e.id}>
                      Already logged: {formatDate(e.expense_date)} · {e.supplier_name || e.category} · ${Number(e.amount).toFixed(2)} ex GST
                    </option>
                  ))}
                </select>
              </Field>
              {form.expense === NEW_EXPENSE && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Field label="Amount ex GST *" error={errors.amount}>
                    <Input inputMode="decimal" value={form.amount} onChange={(e) => set("amount", e.target.value)} placeholder="0.00" />
                  </Field>
                  <Field label="GST">
                    <Input inputMode="decimal" value={form.gst_amount} onChange={(e) => set("gst_amount", e.target.value)} placeholder="0.00" />
                  </Field>
                  <Field label="Invoice #">
                    <Input value={form.invoice_number} onChange={(e) => set("invoice_number", e.target.value)} />
                  </Field>
                  <p className="sm:col-span-3 text-xs text-slate-400">Saved as an expense; attach the invoice copy to it in Expenses &amp; Service.</p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setShowForm(false); setErrors({}); }}>Cancel</Button>
              <Button onClick={save} disabled={saving}>{saving ? "Saving..." : "Save service"}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {sorted.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-slate-400">
            <Wrench className="w-10 h-10 mb-2 opacity-40" />
            <p className="text-sm">No services recorded yet</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sorted.map((r) => {
            const exp = r.expense_id ? expenseById.get(r.expense_id) : null;
            return (
              <Card key={r.id}>
                <CardContent className="py-3 space-y-1.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-sm text-slate-900">
                        {SERVICE_TYPE_LABELS[r.service_type] ?? r.service_type} · {formatDate(r.service_date)}
                      </p>
                      <p className="text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                        {r.provider && <span>{r.provider}</span>}
                        {r.odometer_km != null && <span className="flex items-center gap-1"><Gauge className="w-3 h-3" />{r.odometer_km.toLocaleString("en-AU")} km</span>}
                        {r.engine_hours != null && <span>{Number(r.engine_hours).toLocaleString("en-AU")} engine h</span>}
                        {exp && <span className="flex items-center gap-1"><Receipt className="w-3 h-3" />${Number(exp.amount).toFixed(2)} ex GST{exp.invoice_number ? ` · inv ${exp.invoice_number}` : ""}</span>}
                      </p>
                    </div>
                    {canEdit && (
                      <button type="button" aria-label="Delete service record" onClick={() => remove(r)} className="text-slate-300 hover:text-red-500 shrink-0">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  {r.work_done && <p className="text-sm text-slate-700 whitespace-pre-wrap">{r.work_done}</p>}
                  {(r.next_due_date || r.next_due_km != null || r.next_due_hours != null) && (
                    <p className="text-xs text-slate-500">
                      Next due:{" "}
                      {[
                        r.next_due_date && formatDate(r.next_due_date),
                        r.next_due_km != null && `${r.next_due_km.toLocaleString("en-AU")} km`,
                        r.next_due_hours != null && `${Number(r.next_due_hours).toLocaleString("en-AU")} h`,
                      ].filter(Boolean).join(" or ")}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
