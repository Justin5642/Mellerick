"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2 } from "lucide-react";
import {
  DEFAULT_COST_CENTRE_BY_TYPE,
  HIRE_TYPE_LABELS,
  HIRE_UNITS_BY_TYPE,
  HIRE_UNIT_LABELS,
  floatMoveCharge,
  hireOptionLabel,
  type HireType,
  type HireUnit,
} from "@/lib/hire-pricing";

// Fleet → Hire setup for one machine (Day Works / Hire, Stage 1). How the
// machine is hired out and at what rate, ex GST. A machine can have more than
// one way (the Cat 962H: wet by the hour, or dry by the day). The cost centre
// defaults from the hire type; the operator never picks it.
//
// equipment_hire_options is office/admin only by RLS, so this is only shown to
// them. Operator labour is NOT in these rates — it is costed separately.

export interface HireOptionRow {
  id: string;
  equipment_id: string;
  hire_type: HireType;
  hire_unit: HireUnit;
  rate: number;
  fuel_included: boolean;
  whole_days_only: boolean;
  float_base: number;
  float_km_included: number;
  float_per_km: number;
  cost_centre_id: string | null;
  is_active: boolean;
  notes: string | null;
}

interface FormRow {
  id: string | null;
  hire_type: HireType;
  hire_unit: HireUnit;
  rate: string;
  fuel_included: boolean;
  whole_days_only: boolean;
  float_base: string;
  float_km_included: string;
  float_per_km: string;
  cost_centre_id: string;
  is_active: boolean;
  notes: string;
}

const toForm = (o: HireOptionRow): FormRow => ({
  id: o.id,
  hire_type: o.hire_type,
  hire_unit: o.hire_unit,
  rate: String(o.rate ?? 0),
  fuel_included: o.fuel_included,
  whole_days_only: o.whole_days_only,
  float_base: String(o.float_base ?? 0),
  float_km_included: String(o.float_km_included ?? 0),
  float_per_km: String(o.float_per_km ?? 0),
  cost_centre_id: o.cost_centre_id ?? "",
  is_active: o.is_active,
  notes: o.notes ?? "",
});

const blank = (): FormRow => ({
  id: null, hire_type: "wet", hire_unit: "hour", rate: "", fuel_included: true, whole_days_only: false,
  float_base: "", float_km_included: "30", float_per_km: "", cost_centre_id: "", is_active: true, notes: "",
});

interface Props {
  equipmentId: string;
  equipmentName: string;
  options: HireOptionRow[];
  costCentres: { id: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (options: HireOptionRow[]) => void;
}

export function EquipmentHireDialog({ equipmentId, equipmentName, options, costCentres, open, onOpenChange, onSaved }: Props) {
  const supabase = createClient();
  const [rows, setRows] = useState<FormRow[]>(() => (options.length > 0 ? options.map(toForm) : [blank()]));
  const [saving, setSaving] = useState(false);

  const set = (i: number, patch: Partial<FormRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const defaultCentreName = (t: HireType) => DEFAULT_COST_CENTRE_BY_TYPE[t];

  async function save() {
    const keys = rows.map((r) => `${r.hire_type}|${r.hire_unit}`);
    if (new Set(keys).size !== keys.length) return toast.error("Each way of hiring can only be listed once per machine.");
    for (const r of rows) {
      for (const v of [r.rate, r.float_base, r.float_km_included, r.float_per_km]) {
        if (v.trim() !== "" && (!Number.isFinite(Number(v)) || Number(v) < 0)) return toast.error("Rates can't be negative or blank text.");
      }
    }
    setSaving(true);
    try {
      // Saved by (machine, type, unit); anything no longer listed is removed.
      const dropped = options.filter((o) => !keys.includes(`${o.hire_type}|${o.hire_unit}`)).map((o) => o.id);
      if (dropped.length > 0) {
        const { error } = await supabase.from("equipment_hire_options").delete().in("id", dropped);
        if (error) throw error;
      }
      const payload = rows.map((r) => ({
        equipment_id: equipmentId,
        hire_type: r.hire_type,
        hire_unit: r.hire_unit,
        rate: r.hire_type === "float" ? 0 : Number(r.rate || 0),
        fuel_included: r.fuel_included,
        whole_days_only: r.hire_unit === "day" && r.whole_days_only,
        float_base: r.hire_type === "float" ? Number(r.float_base || 0) : 0,
        float_km_included: r.hire_type === "float" ? Number(r.float_km_included || 0) : 0,
        float_per_km: r.hire_type === "float" ? Number(r.float_per_km || 0) : 0,
        cost_centre_id: r.cost_centre_id || null,
        is_active: r.is_active,
        notes: r.notes.trim() || null,
      }));
      const { data, error } = await supabase
        .from("equipment_hire_options")
        .upsert(payload, { onConflict: "equipment_id,hire_type,hire_unit" })
        .select("*");
      if (error) throw error;
      toast.success("Hire setup saved");
      onSaved((data ?? []) as HireOptionRow[]);
      onOpenChange(false);
    } catch (err) {
      toast.error((err as { message?: string }).message ?? "Couldn't save the hire setup.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{equipmentName} — Hire setup</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-slate-500">
          How this machine is charged as Day Works, ex GST. Operator labour is costed separately and is not in these rates. For a truck, Cartage per tonne / per m³ and per km are the rates its Truck loads are charged at.
        </p>
        <div className="space-y-4">
          {rows.map((r, i) => (
            <div key={r.id ?? `new-${i}`} className="rounded-md border p-3 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label>Hire type</Label>
                  <select
                    className="h-9 w-full rounded-md border px-2 text-sm"
                    value={r.hire_type}
                    onChange={(e) => {
                      const t = e.target.value as HireType;
                      set(i, { hire_type: t, hire_unit: HIRE_UNITS_BY_TYPE[t][0] });
                    }}
                  >
                    {(Object.keys(HIRE_TYPE_LABELS) as HireType[]).map((t) => <option key={t} value={t}>{HIRE_TYPE_LABELS[t]}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label>Charged</Label>
                  <select
                    className="h-9 w-full rounded-md border px-2 text-sm"
                    value={r.hire_unit}
                    onChange={(e) => set(i, { hire_unit: e.target.value as HireUnit })}
                    disabled={HIRE_UNITS_BY_TYPE[r.hire_type].length === 1}
                  >
                    {HIRE_UNITS_BY_TYPE[r.hire_type].map((u) => <option key={u} value={u}>{HIRE_UNIT_LABELS[u]}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label>Cost centre</Label>
                  <select
                    className="h-9 w-full rounded-md border px-2 text-sm"
                    value={r.cost_centre_id}
                    onChange={(e) => set(i, { cost_centre_id: e.target.value })}
                  >
                    <option value="">Default ({defaultCentreName(r.hire_type)})</option>
                    {costCentres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </div>

              {r.hire_type === "float" ? (
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label>Base $</Label>
                    <Input type="number" min={0} step={1} value={r.float_base} onChange={(e) => set(i, { float_base: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label>Km covered by base</Label>
                    <Input type="number" min={0} step={1} value={r.float_km_included} onChange={(e) => set(i, { float_km_included: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label>$ per km beyond</Label>
                    <Input type="number" min={0} step={0.5} value={r.float_per_km} onChange={(e) => set(i, { float_per_km: e.target.value })} />
                  </div>
                  <p className="col-span-3 text-xs text-slate-500">
                    Loaded leg only. e.g. 50 km = ${floatMoveCharge(50, { float_base: r.float_base, float_km_included: r.float_km_included, float_per_km: r.float_per_km }).toFixed(2)}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                  <div className="space-y-1">
                    <Label>Rate $ {HIRE_UNIT_LABELS[r.hire_unit]}</Label>
                    <Input type="number" min={0} step={1} value={r.rate} onChange={(e) => set(i, { rate: e.target.value })} />
                  </div>
                  <label className="flex items-center gap-2 text-sm pb-2">
                    <input type="checkbox" checked={r.fuel_included} onChange={(e) => set(i, { fuel_included: e.target.checked })} />
                    Fuel included
                  </label>
                  {r.hire_unit === "day" && (
                    <label className="flex items-center gap-2 text-sm pb-2">
                      <input type="checkbox" checked={r.whole_days_only} onChange={(e) => set(i, { whole_days_only: e.target.checked })} />
                      Full days only
                    </label>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <Input className="flex-1 min-w-[12rem]" value={r.notes} onChange={(e) => set(i, { notes: e.target.value })} placeholder="Notes (optional)" />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={r.is_active} onChange={(e) => set(i, { is_active: e.target.checked })} />
                  Offered
                </label>
                <Button
                  variant="ghost" size="sm" className="text-slate-400 hover:text-red-600"
                  onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  aria-label={`Remove ${hireOptionLabel(r)}`}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500">
          Removing a way of hiring leaves any Day Works lines entered under it without a rate — untick &ldquo;Offered&rdquo; instead to stop new ones.
        </p>
        <div className="flex justify-between gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setRows((rs) => [...rs, blank()])}>
            <Plus className="w-4 h-4" />Another way to hire it
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
