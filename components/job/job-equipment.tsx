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
import { computeEquipmentCost, EQUIPMENT_CATEGORY_LABELS, type EquipmentCostInputs } from "@/lib/equipment-cost";

interface EquipmentOption extends EquipmentCostInputs {
  id: string;
  name: string;
  category: string;
}

interface UsageEntry {
  id: string;
  equipment_id: string;
  usage_date: string;
  hours: number;
  notes: string | null;
}

interface Props {
  jobId: string;
  usage: UsageEntry[];
  equipmentOptions: EquipmentOption[];
  onUpdate: (usage: UsageEntry[]) => void;
}

export function JobEquipment({ jobId, usage: initialUsage, equipmentOptions, onUpdate }: Props) {
  const supabase = createClient();
  const [usage, setUsage] = useState<UsageEntry[]>(initialUsage);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    equipment_id: equipmentOptions[0]?.id ?? "",
    usage_date: "",
    hours: "",
    notes: "",
  });
  const [errors, setErrors] = useState<Record<string, boolean>>({});

  const equipmentById = new Map(equipmentOptions.map((e) => [e.id, e]));

  function costPerHourFor(equipmentId: string) {
    const eq = equipmentById.get(equipmentId);
    return eq ? computeEquipmentCost(eq).costPerHour : 0;
  }

  async function saveUsage() {
    if (!form.equipment_id) { setErrors({ equipment_id: true }); return; }
    if (!form.usage_date) { setErrors({ usage_date: true }); return; }
    if (!form.hours || Number(form.hours) <= 0) { setErrors({ hours: true }); return; }
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
        hours: Number(form.hours),
        notes: form.notes || null,
        logged_by: user?.id ?? null,
      })
      .select()
      .single();

    if (error || !data) { toast.error("Failed to log equipment usage"); setSaving(false); return; }

    const updated = [data as UsageEntry, ...usage];
    setUsage(updated);
    onUpdate(updated);
    setShowForm(false);
    setForm({ equipment_id: equipmentOptions[0]?.id ?? "", usage_date: "", hours: "", notes: "" });
    toast.success("Equipment usage logged");
    setSaving(false);
  }

  async function deleteUsage(entry: UsageEntry) {
    await supabase.from("equipment_usage_log").delete().eq("id", entry.id);
    const updated = usage.filter((u) => u.id !== entry.id);
    setUsage(updated);
    onUpdate(updated);
    toast.success("Usage entry removed");
  }

  const totalCost = usage.reduce((sum, u) => sum + Number(u.hours) * costPerHourFor(u.equipment_id), 0);
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
        const cost = Number(entry.hours) * costPerHourFor(entry.equipment_id);
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
                <span className="text-slate-500">Hours</span>
                <span className="font-medium text-slate-800">{Number(entry.hours).toFixed(1)}h</span>
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
                  <div className="space-y-1.5">
                    <Label>Hours *</Label>
                    <Input
                      type="number" step="0.5"
                      value={form.hours}
                      onChange={(e) => { setForm((f) => ({ ...f, hours: e.target.value })); setErrors({}); }}
                      placeholder="e.g. 4"
                      className={errors.hours ? "border-red-500 focus-visible:ring-red-500" : ""}
                    />
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
