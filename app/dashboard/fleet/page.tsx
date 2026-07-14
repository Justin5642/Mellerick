"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Truck, Plus, DollarSign } from "lucide-react";
import { EquipmentCostDialog } from "@/components/fleet/equipment-cost-dialog";
import { computeEquipmentCost, EQUIPMENT_CATEGORY_LABELS } from "@/lib/equipment-cost";
import { ListPageSkeleton } from "@/components/ui/loading-skeletons";
import { equipmentCategoryColors } from "@/lib/badge-colors";

export default function FleetPage() {
  const supabase = createClient();
  const [equipment, setEquipment] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", category: "vehicle", registration: "" });
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [role, setRole] = useState<string | null>(null);
  const [costDialogFor, setCostDialogFor] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    async function load() {
      const [{ data, error }, { data: { user } }] = await Promise.all([
        supabase.from("equipment").select("*").order("name"),
        supabase.auth.getUser(),
      ]);
      if (error) setFetchError(error.message);
      setEquipment(data ?? []);
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
        setRole(profile?.role ?? null);
      }
      setLoading(false);
    }
    load();
  }, []);

  const isAdmin = role === "admin";

  function setField(field: string, value: string) {
    setForm((p) => ({ ...p, [field]: value }));
    if (errors[field]) setErrors((p) => ({ ...p, [field]: false }));
  }

  function fieldErr(field: string) {
    return errors[field] ? "border-red-500 focus-visible:ring-red-500" : "";
  }

  async function handleAdd() {
    if (!form.name.trim()) {
      setErrors({ name: true });
      return;
    }
    setSaving(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("equipment")
      .insert({
        name: form.name.trim(),
        category: form.category,
        registration: form.registration || null,
        updated_by: user?.id ?? null,
      })
      .select()
      .single();
    setSaving(false);
    if (error || !data) {
      toast.error("Failed to add equipment");
      return;
    }
    setEquipment((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
    setShowForm(false);
    setForm({ name: "", category: "vehicle", registration: "" });
    toast.success("Equipment added");
  }

  async function toggleActive(id: string, current: boolean) {
    await supabase.from("equipment").update({ is_active: !current }).eq("id", id);
    setEquipment((eq) => eq.map((e) => (e.id === id ? { ...e, is_active: !current } : e)));
    toast.success(current ? "Marked inactive" : "Marked active");
  }

  if (loading) return <ListPageSkeleton />;
  if (fetchError) return <div className="p-6 text-red-500 text-sm">Error loading fleet: {fetchError}</div>;

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Fleet</h1>
          <p className="text-slate-500 text-sm mt-1">{equipment.filter((e) => e.is_active).length} active vehicles/machinery</p>
        </div>
        {isAdmin && (
          <Button className="gap-2" onClick={() => setShowForm((v) => !v)}>
            <Plus className="w-4 h-4" />Add Equipment
          </Button>
        )}
      </div>

      {showForm && (
        <Card>
          <CardHeader><CardTitle className="text-base">Add Vehicle / Machinery</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Name *</Label>
                <Input value={form.name} onChange={(e) => setField("name", e.target.value)} placeholder="e.g. Ute 1 - Hilux" className={fieldErr("name")} />
                {errors.name && <p className="text-xs text-red-500">Name is required</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={(v) => setField("category", v ?? "vehicle")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(EQUIPMENT_CATEGORY_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Registration</Label>
                <Input value={form.registration} onChange={(e) => setField("registration", e.target.value)} placeholder="Optional rego plate" />
              </div>
            </div>
            <p className="text-xs text-slate-400">Add the cost details (purchase price, insurance, fuel, etc.) afterwards via &ldquo;Cost &amp; Usage&rdquo;.</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button onClick={handleAdd} disabled={saving}>{saving ? "Adding..." : "Add Equipment"}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {equipment.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <Truck className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm">No vehicles or machinery added yet</p>
            </div>
          ) : (
            <div className="divide-y">
              {equipment.map((item) => {
                const { costPerHour, annualTotalCost } = computeEquipmentCost(item);
                return (
                  <div key={item.id} className="flex items-center justify-between px-6 py-4">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-500">
                        <Truck className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm text-slate-900">{item.name}</p>
                          {!item.is_active && <span className="text-xs text-slate-400">(inactive)</span>}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${equipmentCategoryColors[item.category] ?? ""}`}>
                            {EQUIPMENT_CATEGORY_LABELS[item.category] ?? item.category}
                          </span>
                          {item.registration && <span className="text-xs text-slate-500">{item.registration}</span>}
                          <span className="text-xs text-slate-500">
                            ${costPerHour.toFixed(2)}/hr · ${annualTotalCost.toLocaleString("en-AU", { maximumFractionDigits: 0 })}/yr
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Button
                        variant="ghost" size="sm"
                        className="text-xs h-7 gap-1 text-slate-400 hover:text-green-700"
                        onClick={() => setCostDialogFor({ id: item.id, name: item.name })}
                      >
                        <DollarSign className="w-3 h-3" />Cost &amp; Usage
                      </Button>
                      {isAdmin && (
                        <Button
                          variant="ghost" size="sm"
                          className={`text-xs h-7 ${item.is_active ? "text-slate-400 hover:text-red-500" : "text-slate-400 hover:text-green-600"}`}
                          onClick={() => toggleActive(item.id, item.is_active)}
                        >
                          {item.is_active ? "Deactivate" : "Reactivate"}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {costDialogFor && (
        <EquipmentCostDialog
          equipmentId={costDialogFor.id}
          equipmentName={costDialogFor.name}
          open={!!costDialogFor}
          onOpenChange={(open) => !open && setCostDialogFor(null)}
        />
      )}
    </div>
  );
}
