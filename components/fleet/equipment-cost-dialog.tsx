"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Trash2 } from "lucide-react";
import { computeEquipmentCost, type EquipmentCostInputs } from "@/lib/equipment-cost";
import { formatDate } from "@/lib/date";

interface UsageEntry {
  id: string;
  usage_date: string;
  hours: number;
  notes: string | null;
  job_id: string | null;
  jobs?: { job_number: number; title: string } | null;
}

const emptyCostForm: EquipmentCostInputs = {
  purchase_cost: 0,
  estimated_life_years: 5,
  insurance_annual: 0,
  maintenance_annual: 0,
  registration_annual: 0,
  other_annual_costs: 0,
  fuel_cost_per_hour: 0,
  target_hours_per_year: 1000,
};

const emptyUsageForm = { usage_date: "", hours: "", notes: "" };

interface Props {
  equipmentId: string;
  equipmentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EquipmentCostDialog({ equipmentId, equipmentName, open, onOpenChange }: Props) {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [costForm, setCostForm] = useState<EquipmentCostInputs>(emptyCostForm);
  const [purchaseDate, setPurchaseDate] = useState("");
  const [usageEntries, setUsageEntries] = useState<UsageEntry[]>([]);
  const [usageForm, setUsageForm] = useState(emptyUsageForm);
  const [addingUsage, setAddingUsage] = useState(false);

  useEffect(() => {
    if (!open) return;
    async function load() {
      setLoading(true);
      const [{ data: equipment }, { data: usage }] = await Promise.all([
        supabase.from("equipment").select("*").eq("id", equipmentId).maybeSingle(),
        supabase
          .from("equipment_usage_log")
          .select("*, jobs(job_number, title)")
          .eq("equipment_id", equipmentId)
          .order("usage_date", { ascending: false }),
      ]);
      if (equipment) {
        setCostForm({
          purchase_cost: Number(equipment.purchase_cost),
          estimated_life_years: Number(equipment.estimated_life_years),
          insurance_annual: Number(equipment.insurance_annual),
          maintenance_annual: Number(equipment.maintenance_annual),
          registration_annual: Number(equipment.registration_annual),
          other_annual_costs: Number(equipment.other_annual_costs),
          fuel_cost_per_hour: Number(equipment.fuel_cost_per_hour),
          target_hours_per_year: Number(equipment.target_hours_per_year),
        });
        setPurchaseDate(equipment.purchase_date ?? "");
      } else {
        setCostForm(emptyCostForm);
        setPurchaseDate("");
      }
      setUsageEntries((usage as any) ?? []);
      setLoading(false);
    }
    load();
  }, [open, equipmentId]);

  function setField(field: keyof EquipmentCostInputs, value: string) {
    setCostForm((p) => ({ ...p, [field]: value === "" ? 0 : parseFloat(value) }));
  }

  async function saveCostProfile() {
    setSaving(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("equipment")
      .update({
        ...costForm,
        purchase_date: purchaseDate || null,
        updated_at: new Date().toISOString(),
        updated_by: user?.id ?? null,
      })
      .eq("id", equipmentId);
    setSaving(false);
    if (error) {
      toast.error("Failed to save cost profile");
      return;
    }
    toast.success("Cost profile saved");
  }

  async function addUsage() {
    if (!usageForm.usage_date || !usageForm.hours) {
      toast.error("Date and hours are required");
      return;
    }
    setAddingUsage(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("equipment_usage_log")
      .insert({
        equipment_id: equipmentId,
        usage_date: usageForm.usage_date,
        hours: parseFloat(usageForm.hours),
        notes: usageForm.notes || null,
        logged_by: user?.id ?? null,
      })
      .select("*, jobs(job_number, title)")
      .single();
    setAddingUsage(false);
    if (error || !data) {
      toast.error("Failed to log usage");
      return;
    }
    setUsageEntries((prev) => [data as UsageEntry, ...prev]);
    setUsageForm(emptyUsageForm);
    toast.success("Usage logged");
  }

  async function deleteUsage(id: string) {
    const { error } = await supabase.from("equipment_usage_log").delete().eq("id", id);
    if (error) {
      toast.error("Failed to delete usage entry");
      return;
    }
    setUsageEntries((prev) => prev.filter((u) => u.id !== id));
  }

  const { annualTotalCost, costPerHour } = computeEquipmentCost(costForm);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{equipmentName} — Cost &amp; Usage</DialogTitle>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-slate-400 py-8 text-center">Loading...</p>
        ) : (
          <Tabs defaultValue="cost">
            <TabsList>
              <TabsTrigger value="cost">Cost Profile</TabsTrigger>
              <TabsTrigger value="usage">Usage Log</TabsTrigger>
            </TabsList>

            <TabsContent value="cost" className="space-y-4 pt-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Purchase Cost ($)</Label>
                  <Input type="number" step="1" value={costForm.purchase_cost} onChange={(e) => setField("purchase_cost", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Purchase Date</Label>
                  <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Estimated Life (years)</Label>
                  <Input type="number" step="0.5" value={costForm.estimated_life_years} onChange={(e) => setField("estimated_life_years", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Target Hours/Year</Label>
                  <Input type="number" step="10" value={costForm.target_hours_per_year} onChange={(e) => setField("target_hours_per_year", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Insurance ($/year)</Label>
                  <Input type="number" step="1" value={costForm.insurance_annual} onChange={(e) => setField("insurance_annual", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Maintenance ($/year)</Label>
                  <Input type="number" step="1" value={costForm.maintenance_annual} onChange={(e) => setField("maintenance_annual", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Registration ($/year)</Label>
                  <Input type="number" step="1" value={costForm.registration_annual} onChange={(e) => setField("registration_annual", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Fuel ($/hour)</Label>
                  <Input type="number" step="0.5" value={costForm.fuel_cost_per_hour} onChange={(e) => setField("fuel_cost_per_hour", e.target.value)} />
                </div>
                <div className="space-y-1.5 col-span-2">
                  <Label>Other Annual Costs ($)</Label>
                  <Input type="number" step="1" value={costForm.other_annual_costs} onChange={(e) => setField("other_annual_costs", e.target.value)} />
                </div>
              </div>

              <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-500">Cost Per Hour</p>
                  <p className="text-lg font-bold text-slate-900">${costPerHour.toFixed(2)}/hr</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-slate-500">Annual Total Cost</p>
                  <p className="text-lg font-bold text-slate-900">${annualTotalCost.toLocaleString("en-AU", { maximumFractionDigits: 0 })}</p>
                </div>
              </div>

              <div className="flex justify-end">
                <Button onClick={saveCostProfile} disabled={saving}>{saving ? "Saving..." : "Save Cost Profile"}</Button>
              </div>
            </TabsContent>

            <TabsContent value="usage" className="space-y-4 pt-3">
              <div className="grid grid-cols-2 gap-3 items-end">
                <div className="space-y-1.5">
                  <Label>Date</Label>
                  <Input type="date" value={usageForm.usage_date} onChange={(e) => setUsageForm((p) => ({ ...p, usage_date: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>Hours</Label>
                  <Input type="number" step="0.5" value={usageForm.hours} onChange={(e) => setUsageForm((p) => ({ ...p, hours: e.target.value }))} placeholder="e.g. 4" />
                </div>
                <div className="space-y-1.5 col-span-2">
                  <Label>Notes</Label>
                  <Input value={usageForm.notes} onChange={(e) => setUsageForm((p) => ({ ...p, notes: e.target.value }))} placeholder="e.g. Servicing, general use" />
                </div>
              </div>
              <p className="text-xs text-slate-400">
                To log usage against a specific job (so it counts in that job&apos;s costing), use the Equipment tab on the job itself. Entries logged here are general/non-job use.
              </p>
              <Button onClick={addUsage} disabled={addingUsage} size="sm">{addingUsage ? "Logging..." : "Log Usage"}</Button>

              <div className="space-y-2 pt-2 border-t">
                {usageEntries.length === 0 ? (
                  <p className="text-sm text-slate-400 text-center py-4">No usage logged yet</p>
                ) : (
                  usageEntries.map((u) => (
                    <div key={u.id} className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2 text-sm">
                      <div>
                        <span className="font-medium text-slate-700">{formatDate(u.usage_date)}</span>
                        <span className="ml-2 font-semibold text-slate-800">{Number(u.hours).toFixed(1)}h</span>
                        {u.jobs && (
                          <span className="ml-2 text-xs text-blue-600">#{u.jobs.job_number} — {u.jobs.title}</span>
                        )}
                        {u.notes && <p className="text-xs text-slate-400 mt-0.5">{u.notes}</p>}
                      </div>
                      <button onClick={() => deleteUsage(u.id)} className="text-slate-300 hover:text-red-500">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
