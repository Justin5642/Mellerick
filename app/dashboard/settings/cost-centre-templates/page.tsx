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
import { ListPageSkeleton } from "@/components/ui/loading-skeletons";

// The company's cost centres (migration 0087, DRAFT, not applied yet: Below Ground Drainage,
// Transport, Above Ground Plumbing, Civil, plus any added here) and the stages
// under each. Stages are the cost_center_templates rows a job's Purchase Order
// loads; their group_name is kept equal to the cost centre's name so older
// readers (the phone's settings screen) still group them the same way.

interface CostCentre {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

interface TemplateItem {
  id: string;
  group_name: string;
  cost_centre_id: string | null;
  name: string;
  code: string | null;
  sort_order: number;
  is_active: boolean;
}

export default function CostCentresPage() {
  const supabase = createClient();
  const [centres, setCentres] = useState<CostCentre[]>([]);
  const [items, setItems] = useState<TemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [stageFormFor, setStageFormFor] = useState<string | null>(null);
  const [stageForm, setStageForm] = useState({ name: "", code: "" });
  const [newCentre, setNewCentre] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    const [c, t] = await Promise.all([
      supabase.from("cost_centres").select("id, name, sort_order, is_active").order("sort_order").order("name"),
      supabase.from("cost_center_templates").select("id, group_name, cost_centre_id, name, code, sort_order, is_active").order("sort_order"),
    ]);
    setLoadFailed(!!(c.error || t.error));
    setCentres((c.data as CostCentre[]) ?? []);
    setItems((t.data as TemplateItem[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addCentre(e: React.FormEvent) {
    e.preventDefault();
    const name = newCentre.trim();
    if (!name) return;
    setSaving(true);
    const nextSort = centres.length > 0 ? Math.max(...centres.map((c) => c.sort_order)) + 1 : 1;
    const { error } = await supabase.from("cost_centres").insert({ name, sort_order: nextSort });
    setSaving(false);
    if (error) {
      toast.error(error.code === "23505" ? `There's already a cost centre called ${name}.` : "Couldn't add the cost centre.");
      return;
    }
    setNewCentre("");
    toast.success("Cost centre added");
    load();
  }

  async function toggleCentre(centre: CostCentre) {
    const { error, count } = await supabase
      .from("cost_centres")
      .update({ is_active: !centre.is_active }, { count: "exact" })
      .eq("id", centre.id);
    if (error || count === 0) {
      toast.error("Couldn't change this cost centre.");
      return;
    }
    setCentres((prev) => prev.map((c) => (c.id === centre.id ? { ...c, is_active: !c.is_active } : c)));
  }

  async function addStage(e: React.FormEvent, centre: CostCentre) {
    e.preventDefault();
    if (!stageForm.name.trim()) {
      toast.error("Stage name is required");
      return;
    }
    setSaving(true);
    const centreItems = items.filter((i) => i.cost_centre_id === centre.id);
    const nextSort = centreItems.length > 0 ? Math.max(...centreItems.map((i) => i.sort_order)) + 1 : 0;
    const { error } = await supabase.from("cost_center_templates").insert({
      group_name: centre.name,
      cost_centre_id: centre.id,
      name: stageForm.name.trim(),
      code: stageForm.code.trim() || null,
      sort_order: nextSort,
    });
    setSaving(false);
    if (error) {
      toast.error("Couldn't add the stage.");
      return;
    }
    toast.success("Stage added");
    setStageForm({ name: "", code: "" }); // stay open to add several quickly
    load();
  }

  // `count` as well as `error`: PostgREST reports no error for an UPDATE or
  // DELETE matching zero rows, so a refusal is indistinguishable from a
  // success. Updating local state on that response shows the change until the
  // next load and then quietly loses it.
  async function toggleStage(item: TemplateItem) {
    const { error, count } = await supabase
      .from("cost_center_templates")
      .update({ is_active: !item.is_active }, { count: "exact" })
      .eq("id", item.id);
    if (error || count === 0) {
      toast.error("Couldn't change this stage.");
      return;
    }
    setItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, is_active: !x.is_active } : x)));
  }

  async function removeStage(id: string) {
    const { error, count } = await supabase
      .from("cost_center_templates")
      .delete({ count: "exact" })
      .eq("id", id);
    if (error || count === 0) {
      toast.error("Couldn't remove this stage.");
      return;
    }
    setItems((prev) => prev.filter((x) => x.id !== id));
    toast.success("Removed");
  }

  if (loading) return <ListPageSkeleton />;

  const unfiled = items.filter((i) => !i.cost_centre_id);

  function stageRow(item: TemplateItem) {
    return (
      <div
        key={item.id}
        className={`flex items-center gap-4 rounded-lg border border-slate-100 px-3 py-2 ${!item.is_active ? "opacity-50" : ""}`}
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-800">{item.name}</p>
          {item.code && <p className="text-xs text-slate-400 font-mono">{item.code}</p>}
        </div>
        <button onClick={() => toggleStage(item)} className="text-xs text-slate-400 hover:text-slate-600 underline">
          {item.is_active ? "Deactivate" : "Activate"}
        </button>
        <button onClick={() => removeStage(item.id)} className="text-slate-300 hover:text-red-400 transition-colors">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/settings">
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Cost Centres</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            The company&apos;s cost centres and the stages under each. Every purchase order and cost on a job is tagged
            to one of these, so costs can be added up per cost centre across all jobs.
          </p>
        </div>
      </div>

      {loadFailed && (
        <p className="text-sm text-red-600">Couldn&apos;t load the cost centres. Refresh the page to try again.</p>
      )}

      <div className="space-y-4">
        {centres.map((centre) => {
          const centreItems = items.filter((i) => i.cost_centre_id === centre.id);
          return (
            <Card key={centre.id} className={!centre.is_active ? "opacity-60" : ""}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{centre.name}</CardTitle>
                  <button onClick={() => toggleCentre(centre)} className="text-xs text-slate-400 hover:text-slate-600 underline">
                    {centre.is_active ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {centreItems.map(stageRow)}
                {centreItems.length === 0 && <p className="text-xs text-slate-400">No stages yet.</p>}
                {stageFormFor === centre.id ? (
                  <form onSubmit={(e) => addStage(e, centre)} className="grid grid-cols-12 gap-2 pt-2 items-end">
                    <div className="col-span-6 space-y-1">
                      <Label className="text-xs">Stage name *</Label>
                      <Input value={stageForm.name} onChange={(e) => setStageForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Sewer" className="h-8" autoFocus />
                    </div>
                    <div className="col-span-3 space-y-1">
                      <Label className="text-xs">Code</Label>
                      <Input value={stageForm.code} onChange={(e) => setStageForm((f) => ({ ...f, code: e.target.value }))} placeholder="Optional" className="h-8" />
                    </div>
                    <div className="col-span-3 flex gap-1 justify-end">
                      <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => setStageFormFor(null)}>Done</Button>
                      <Button type="submit" size="sm" className="h-8" disabled={saving}>Add</Button>
                    </div>
                  </form>
                ) : (
                  <Button variant="ghost" size="sm" className="gap-1 h-7 text-xs" onClick={() => { setStageFormFor(centre.id); setStageForm({ name: "", code: "" }); }}>
                    <Plus className="w-3 h-3" /> Add stage
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}

        {unfiled.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base text-slate-500">Not in a cost centre</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">{unfiled.map(stageRow)}</CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">New Cost Centre</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={addCentre} className="flex gap-2">
            <Input value={newCentre} onChange={(e) => setNewCentre(e.target.value)} placeholder="e.g. Hydraulics" />
            <Button type="submit" disabled={saving || !newCentre.trim()} className="gap-1">
              <Plus className="w-4 h-4" /> Add
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
