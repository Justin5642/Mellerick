"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Truck, Plus, Trash2 } from "lucide-react";
import { formatDate } from "@/lib/date";
import { EQUIPMENT_CATEGORY_LABELS, type EquipmentCostInputs } from "@/lib/equipment-cost";
import { costPerHourOf } from "@/lib/fleet-costs";

interface EquipmentOption extends EquipmentCostInputs {
  id: string;
  name: string;
  category: string;
  cost_per_load?: number | null;
  /** $ per day used (0100 — draft, not applied yet). Day-rated items log whole days. */
  day_rate?: number | null;
}

const isDayRated = (eq: EquipmentOption | undefined) => Number(eq?.day_rate ?? 0) > 0;

interface UsageEntry {
  id: string;
  equipment_id: string;
  usage_date: string;
  hours: number;
  notes: string | null;
  loads?: number | null;
  days?: number | null;
  cost_center_id?: string | null;
}

interface Props {
  jobId: string;
  usage: UsageEntry[];
  equipmentOptions: EquipmentOption[];
  onUpdate: (usage: UsageEntry[]) => void;
  /** The job's PO lines, so usage can be costed to one — cartage to Transport (0091). */
  costCentres?: { id: string; name: string }[];
}

export function JobEquipment({ jobId, usage: initialUsage, equipmentOptions, onUpdate, costCentres = [] }: Props) {
  const supabase = createClient();
  const [usage, setUsage] = useState<UsageEntry[]>(initialUsage);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    equipment_id: equipmentOptions[0]?.id ?? "",
    usage_date: "",
    hours: "",
    loads: "",
    cost_center_id: "",
    notes: "",
  });
  const [errors, setErrors] = useState<Record<string, boolean>>({});

  const equipmentById = new Map(equipmentOptions.map((e) => [e.id, e]));

  function costPerHourFor(equipmentId: string) {
    const eq = equipmentById.get(equipmentId);
    // Actual rate from logged Fleet costs when loaded (lib/fleet-costs.ts), else the estimate.
    return eq ? costPerHourOf(eq) : 0;
  }

  // Hours × cost per hour, plus loads × cost per load (0091), plus tool days
  // × day rate (0100 — draft, not applied yet).
  function costOf(u: UsageEntry) {
    const eq = equipmentById.get(u.equipment_id);
    return (
      Number(u.hours) * costPerHourFor(u.equipment_id) +
      Number(u.loads ?? 0) * Number(eq?.cost_per_load ?? 0) +
      Number(u.days ?? 0) * Number(eq?.day_rate ?? 0)
    );
  }

  async function saveUsage() {
    if (!form.equipment_id) { setErrors({ equipment_id: true }); return; }
    if (!form.usage_date) { setErrors({ usage_date: true }); return; }
    // A day-rated tool is one full day; otherwise hours, loads, or both — a
    // truck run can be loads only.
    const dayRated = isDayRated(equipmentById.get(form.equipment_id));
    if (!dayRated && !(Number(form.hours) > 0) && !(Number(form.loads) > 0)) { setErrors({ hours: true }); return; }
    setSaving(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { data, error } = await supabase
      .from("equipment_usage_log")
      .insert({
        job_id: jobId,
        equipment_id: form.equipment_id,
        usage_date: form.usage_date,
        hours: dayRated ? 0 : Number(form.hours) || 0,
        loads: dayRated ? 0 : Math.max(0, Math.round(Number(form.loads) || 0)),
        days: dayRated ? 1 : 0,
        cost_center_id: form.cost_center_id || null,
        notes: form.notes || null,
        logged_by: user?.id ?? null,
      })
      .select()
      .single();

    if (error || !data) {
      // 23505: this tool is already logged on this job for that day (0100).
      toast.error(error?.code === "23505" ? "That tool is already logged on this job for that day." : "Failed to log equipment usage");
      setSaving(false);
      return;
    }

    const updated = [data as UsageEntry, ...usage];
    setUsage(updated);
    onUpdate(updated);
    setShowForm(false);
    setForm({ equipment_id: equipmentOptions[0]?.id ?? "", usage_date: "", hours: "", loads: "", cost_center_id: "", notes: "" });
    toast.success("Equipment usage logged");
    setSaving(false);
  }

  async function deleteUsage(entry: UsageEntry) {
    // A refused DELETE is not an error in PostgREST — it is a success that
    // removed nothing. Dropping the row from local state on that response
    // makes it look gone until the next load, and this row is billable
    // equipment time.
    const { error, count } = await supabase
      .from("equipment_usage_log")
      .delete({ count: "exact" })
      .eq("id", entry.id);

    if (error || count === 0) {
      toast.error(error?.message ?? "Could not remove this usage entry.");
      return;
    }
    const updated = usage.filter((u) => u.id !== entry.id);
    setUsage(updated);
    onUpdate(updated);
    toast.success("Usage entry removed");
  }

  const totalCost = usage.reduce((sum, u) => sum + costOf(u), 0);
  const totalHours = usage.reduce((sum, u) => sum + Number(u.hours), 0);

  return (
    <div className="p-6 space-y-6">
      {usage.length > 0 && (
        <Card className="border-blue-100 bg-blue-50/40">
          <CardContent className="pt-4 pb-4 space-y-1">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Equipment Cost Logged</p>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Total Hours</span>
              <span className="font-semibold text-slate-800">{totalHours.toFixed(1)}h</span>
            </div>
            <div className="flex justify-between text-sm pt-1 border-t">
              <span className="text-slate-600 font-medium">Total Cost</span>
              <span className="font-bold text-slate-900">${totalCost.toFixed(2)}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {usage.map((entry) => {
        const eq = equipmentById.get(entry.equipment_id);
        const cost = costOf(entry);
        return (
          <Card key={entry.id}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base flex items-center gap-1.5">
                    <Truck className="w-4 h-4 text-slate-400" />
                    {eq?.name ?? "Unknown equipment"}
                  </CardTitle>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {eq ? EQUIPMENT_CATEGORY_LABELS[eq.category] ?? eq.category : ""} · {formatDate(entry.usage_date)}
                    {entry.cost_center_id && ` · ${costCentres.find((c) => c.id === entry.cost_center_id)?.name ?? "cost centre"}`}
                    {Number(entry.loads) > 0 && ` · ${entry.loads} load${entry.loads === 1 ? "" : "s"}`}
                  </p>
                  {entry.notes && <p className="text-sm text-slate-600 mt-1">{entry.notes}</p>}
                </div>
                <button onClick={() => deleteUsage(entry)} className="text-slate-300 hover:text-red-400 transition-colors p-1 shrink-0">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </CardHeader>
            <CardContent className="pt-0 space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">{Number(entry.days) > 0 ? "Used" : "Hours"}</span>
                <span className="font-medium text-slate-800">
                  {Number(entry.days) > 0 ? `1 day @ $${Number(eq?.day_rate ?? 0).toFixed(2)}` : `${Number(entry.hours).toFixed(1)}h`}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Cost</span>
                <span className="font-medium text-slate-800">${cost.toFixed(2)}</span>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {showForm ? (
        <Card>
          <CardHeader><CardTitle className="text-base">Log Equipment Usage</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {equipmentOptions.length === 0 ? (
              <p className="text-sm text-slate-400">No active equipment set up yet — add vehicles/machinery under Fleet first.</p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label>Equipment *</Label>
                  <Select value={form.equipment_id} onValueChange={(v) => { setForm((f) => ({ ...f, equipment_id: v ?? "" })); setErrors({}); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {equipmentOptions.map((eq) => (
                        <SelectItem key={eq.id} value={eq.id}>{eq.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Date *</Label>
                    <Input
                      type="date"
                      value={form.usage_date}
                      onChange={(e) => { setForm((f) => ({ ...f, usage_date: e.target.value })); setErrors({}); }}
                      className={errors.usage_date ? "border-red-500 focus-visible:ring-red-500" : ""}
                    />
                  </div>
                  {isDayRated(equipmentById.get(form.equipment_id)) ? (
                    <div className="space-y-1.5">
                      <Label>Used</Label>
                      <p className="h-9 flex items-center text-sm text-slate-700">
                        1 full day @ ${Number(equipmentById.get(form.equipment_id)?.day_rate ?? 0).toFixed(2)}
                      </p>
                    </div>
                  ) : (
                  <div className="space-y-1.5">
                    <Label>Hours</Label>
                    <Input
                      type="number" step="0.5"
                      value={form.hours}
                      onChange={(e) => { setForm((f) => ({ ...f, hours: e.target.value })); setErrors({}); }}
                      placeholder="e.g. 4"
                      className={errors.hours ? "border-red-500 focus-visible:ring-red-500" : ""}
                    />
                  </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  {isDayRated(equipmentById.get(form.equipment_id)) ? <div /> : (
                  <div className="space-y-1.5">
                    <Label>Loads</Label>
                    <Input type="number" step="1" min="0" value={form.loads} onChange={(e) => { setForm((f) => ({ ...f, loads: e.target.value })); setErrors({}); }} placeholder="0" />
                  </div>
                  )}
                  <div className="space-y-1.5">
                    <Label>Cost centre</Label>
                    <select
                      value={form.cost_center_id}
                      onChange={(e) => setForm((f) => ({ ...f, cost_center_id: e.target.value }))}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm"
                    >
                      <option value="">Not tagged</option>
                      {costCentres.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Notes</Label>
                  <Input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Optional" />
                </div>
              </>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button type="button" onClick={saveUsage} disabled={saving || equipmentOptions.length === 0}>
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Button variant="outline" className="gap-2" onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4" />Log Equipment Usage
        </Button>
      )}
    </div>
  );
}
