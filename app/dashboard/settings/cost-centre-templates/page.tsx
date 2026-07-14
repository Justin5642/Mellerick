"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import Link from "next/link";

interface TemplateItem {
  id: string;
  group_name: string;
  name: string;
  code: string | null;
  sort_order: number;
  is_active: boolean;
}

export default function CostCentreTemplatesPage() {
  const supabase = createClient();
  const [items, setItems] = useState<TemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ group_name: "", name: "", code: "" });

  async function load() {
    const { data } = await supabase.from("cost_center_templates").select("*").order("group_name").order("sort_order");
    setItems((data as any) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = Array.from(new Set(items.map((i) => i.group_name)));

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    if (!form.group_name.trim() || !form.name.trim()) {
      toast.error("Group and stage name are required");
      return;
    }
    setSaving(true);
    const groupItems = items.filter((i) => i.group_name === form.group_name.trim());
    const nextSort = groupItems.length > 0 ? Math.max(...groupItems.map((i) => i.sort_order)) + 1 : 0;
    const { error } = await supabase.from("cost_center_templates").insert({
      group_name: form.group_name.trim(),
      name: form.name.trim(),
      code: form.code.trim() || null,
      sort_order: nextSort,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Stage added");
    setForm((f) => ({ group_name: f.group_name, name: "", code: "" })); // keep group selected to add multiple stages quickly
    load();
  }

  async function toggleActive(item: TemplateItem) {
    await supabase.from("cost_center_templates").update({ is_active: !item.is_active }).eq("id", item.id);
    setItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, is_active: !x.is_active } : x)));
  }

  async function remove(id: string) {
    await supabase.from("cost_center_templates").delete().eq("id", id);
    setItems((prev) => prev.filter((x) => x.id !== id));
    toast.success("Removed");
  }

  if (loading) return <div className="p-6 text-slate-400 text-sm">Loading...</div>;

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/settings">
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Cost Centre Templates</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Standard job stages grouped the same way as Simpro (Below Ground Drainage / Above Ground Plumbing /
            Truck Cartage). When adding a Purchase Order, load one group to match a single Simpro-style PO, or
            select several groups at once to merge them into one PO.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {groups.map((group) => {
          const groupItems = items.filter((i) => i.group_name === group);
          return (
            <Card key={group}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{group}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {groupItems.map((item) => (
                  <div
                    key={item.id}
                    className={`flex items-center gap-4 rounded-lg border border-slate-100 px-3 py-2 ${!item.is_active ? "opacity-50" : ""}`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800">{item.name}</p>
                      {item.code && <p className="text-xs text-slate-400 font-mono">{item.code}</p>}
                    </div>
                    <button onClick={() => toggleActive(item)} className="text-xs text-slate-400 hover:text-slate-600 underline">
                      {item.is_active ? "Deactivate" : "Activate"}
                    </button>
                    <button onClick={() => remove(item.id)} className="text-slate-300 hover:text-red-400 transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </CardContent>
            </Card>
          );
        })}

        {groups.length === 0 && (
          <Card>
            <CardContent className="py-10 text-center text-slate-400 text-sm">
              No cost centre templates yet — add a stage below to get started.
            </CardContent>
          </Card>
        )}
      </div>

      {showForm ? (
        <Card>
          <CardHeader><CardTitle className="text-base">New Stage</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={addItem} className="space-y-4">
              <div className="space-y-1.5">
                <Label>Group *</Label>
                <Input
                  value={form.group_name}
                  onChange={(e) => setForm((f) => ({ ...f, group_name: e.target.value }))}
                  placeholder="e.g. Below Ground Drainage"
                  list="cost-centre-groups"
                />
                <datalist id="cost-centre-groups">
                  {groups.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
                <p className="text-xs text-slate-400">Type an existing group name to add to it, or a new one to create a new group.</p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 space-y-1.5">
                  <Label>Stage Name *</Label>
                  <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Sewer" />
                </div>
                <div className="space-y-1.5">
                  <Label>Code</Label>
                  <Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} placeholder="Optional" />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
                <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Add Stage"}</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Button variant="outline" className="gap-2" onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4" /> Add Stage
        </Button>
      )}
    </div>
  );
}
