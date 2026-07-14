"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ArrowLeft, Plus, Trash2, Zap, UserCheck } from "lucide-react";
import Link from "next/link";
import { ListPageSkeleton } from "@/components/ui/loading-skeletons";

interface VariationType {
  id: string;
  name: string;
  unit: string;
  rate: number;
  auto_approve: boolean;
  is_active: boolean;
}

export default function VariationTypesPage() {
  const supabase = createClient();
  const [types, setTypes] = useState<VariationType[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", unit: "m³", rate: "", auto_approve: true });

  async function load() {
    const { data } = await supabase.from("variation_types").select("*").order("name");
    setTypes((data as any) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addType(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("variation_types").insert({
      name: form.name.trim(),
      unit: form.unit.trim() || "unit",
      rate: parseFloat(form.rate) || 0,
      auto_approve: form.auto_approve,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Variation type added");
    setForm({ name: "", unit: "m³", rate: "", auto_approve: true });
    setShowForm(false);
    load();
  }

  async function updateRate(id: string, rate: number) {
    await supabase.from("variation_types").update({ rate }).eq("id", id);
  }

  async function toggleAutoApprove(t: VariationType) {
    await supabase.from("variation_types").update({ auto_approve: !t.auto_approve }).eq("id", t.id);
    setTypes((prev) => prev.map((x) => (x.id === t.id ? { ...x, auto_approve: !x.auto_approve } : x)));
  }

  async function toggleActive(t: VariationType) {
    await supabase.from("variation_types").update({ is_active: !t.is_active }).eq("id", t.id);
    setTypes((prev) => prev.map((x) => (x.id === t.id ? { ...x, is_active: !x.is_active } : x)));
  }

  async function remove(id: string) {
    await supabase.from("variation_types").delete().eq("id", id);
    setTypes((prev) => prev.filter((t) => t.id !== id));
    toast.success("Removed");
  }

  if (loading) return <ListPageSkeleton />;

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/settings">
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Variation Types</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Standard rates for common variations (rock removal, spoil removal, etc). Auto-approve types let crew log a
            quantity + photo on site and have it approved instantly — everything else needs office pricing first.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {types.map((t) => (
          <Card key={t.id} className={!t.is_active ? "opacity-50" : ""}>
            <CardContent className="pt-4 pb-4 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-slate-800">{t.name}</p>
                <p className="text-xs text-slate-400">per {t.unit}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-slate-400 text-sm">$</span>
                <Input
                  type="number"
                  step="0.01"
                  defaultValue={t.rate}
                  onBlur={(e) => updateRate(t.id, parseFloat(e.target.value) || 0)}
                  className="w-24 h-8 text-sm"
                />
              </div>
              <button
                onClick={() => toggleAutoApprove(t)}
                className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-full transition-colors ${
                  t.auto_approve ? "bg-green-100 text-green-700" : "bg-orange-100 text-orange-700"
                }`}
              >
                {t.auto_approve ? <Zap className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                {t.auto_approve ? "Auto-approve" : "Needs approval"}
              </button>
              <button onClick={() => toggleActive(t)} className="text-xs text-slate-400 hover:text-slate-600 underline">
                {t.is_active ? "Deactivate" : "Activate"}
              </button>
              <button onClick={() => remove(t.id)} className="text-slate-300 hover:text-red-400 transition-colors">
                <Trash2 className="w-4 h-4" />
              </button>
            </CardContent>
          </Card>
        ))}

        {types.length === 0 && (
          <Card>
            <CardContent className="py-10 text-center text-slate-400 text-sm">
              No variation types yet — add "Rock Removal" or "Spoil Removal" to get started.
            </CardContent>
          </Card>
        )}
      </div>

      {showForm ? (
        <Card>
          <CardHeader><CardTitle className="text-base">New Variation Type</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={addType} className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-1 space-y-1.5">
                  <Label>Name *</Label>
                  <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Rock Removal" />
                </div>
                <div className="space-y-1.5">
                  <Label>Unit</Label>
                  <Input value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} placeholder="m³" />
                </div>
                <div className="space-y-1.5">
                  <Label>Rate ($)</Label>
                  <Input type="number" step="0.01" value={form.rate} onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))} placeholder="0.00" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={form.auto_approve}
                  onChange={(e) => setForm((f) => ({ ...f, auto_approve: e.target.checked }))}
                />
                Auto-approve (crew can log this on site without office sign-off)
              </label>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
                <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Add Type"}</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Button variant="outline" className="gap-2" onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4" /> Add Variation Type
        </Button>
      )}
    </div>
  );
}
