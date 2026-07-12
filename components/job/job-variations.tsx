"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Trash2, Zap, Clock3, CheckCircle2, XCircle, ImageIcon } from "lucide-react";

interface VariationType {
  id: string;
  name: string;
  unit: string;
  rate: number;
  auto_approve: boolean;
}

interface Variation {
  id: string;
  variation_type_id: string | null;
  custom_name: string | null;
  description: string | null;
  quantity: number;
  unit: string;
  rate: number | null;
  total_amount: number | null;
  photo_storage_path: string | null;
  status: "auto_approved" | "pending_approval" | "approved" | "rejected";
  logged_by: string | null;
  logged_at: string | null;
  admin_notes: string | null;
  variation_types?: { name: string } | null;
  profiles?: { full_name: string } | null;
}

const STATUS_STYLE: Record<string, { bg: string; text: string; icon: any; label: string }> = {
  auto_approved: { bg: "bg-green-100", text: "text-green-700", icon: Zap, label: "Auto-approved" },
  pending_approval: { bg: "bg-orange-100", text: "text-orange-700", icon: Clock3, label: "Pending approval" },
  approved: { bg: "bg-blue-100", text: "text-blue-700", icon: CheckCircle2, label: "Approved" },
  rejected: { bg: "bg-red-100", text: "text-red-700", icon: XCircle, label: "Rejected" },
};

export function JobVariations({
  jobId,
  variations: initial,
  variationTypes,
  currentUserId,
  onUpdate,
}: {
  jobId: string;
  variations: Variation[];
  variationTypes: VariationType[];
  currentUserId: string;
  onUpdate: (v: Variation[]) => void;
}) {
  const supabase = createClient();
  const [variations, setVariations] = useState<Variation[]>(initial);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [typeId, setTypeId] = useState<string>("custom");
  const [customName, setCustomName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [description, setDescription] = useState("");
  const [pricing, setPricing] = useState<Record<string, { rate: string; quantity: string; notes: string }>>({});

  const selectedType = variationTypes.find((t) => t.id === typeId);

  function set(updated: Variation[]) {
    setVariations(updated);
    onUpdate(updated);
  }

  async function addVariation(e: React.FormEvent) {
    e.preventDefault();
    const qty = parseFloat(quantity) || 0;
    if (typeId === "custom" && !customName.trim()) {
      toast.error("Give this variation a name");
      return;
    }
    setSaving(true);
    const isStandard = !!selectedType;
    const autoApprove = !!selectedType?.auto_approve;
    const rate = selectedType?.rate ?? null;
    const unit = selectedType?.unit ?? "unit";
    const total = autoApprove && rate != null ? qty * rate : null;

    const { data, error } = await supabase
      .from("job_variations")
      .insert({
        job_id: jobId,
        variation_type_id: isStandard ? typeId : null,
        custom_name: isStandard ? null : customName.trim(),
        description: description.trim() || null,
        quantity: qty,
        unit,
        rate: autoApprove ? rate : null,
        total_amount: total,
        status: autoApprove ? "auto_approved" : "pending_approval",
        logged_by: currentUserId,
        logged_at: new Date().toISOString(),
      })
      .select("*, variation_types(name), profiles(full_name)")
      .single();

    setSaving(false);
    if (error || !data) {
      toast.error(error?.message ?? "Failed to add variation");
      return;
    }
    set([data as any, ...variations]);
    setShowForm(false);
    setTypeId("custom");
    setCustomName("");
    setQuantity("");
    setDescription("");
    toast.success(autoApprove ? "Variation auto-approved" : "Variation sent to admin for pricing");
  }

  async function priceAndApprove(v: Variation) {
    const p = pricing[v.id] ?? { rate: v.rate?.toString() ?? "", quantity: v.quantity.toString(), notes: "" };
    const rate = parseFloat(p.rate) || 0;
    const qty = parseFloat(p.quantity) || v.quantity;
    const { data, error } = await supabase
      .from("job_variations")
      .update({
        rate,
        quantity: qty,
        total_amount: rate * qty,
        status: "approved",
        approved_by: currentUserId,
        approved_at: new Date().toISOString(),
        admin_notes: p.notes || null,
      })
      .eq("id", v.id)
      .select("*, variation_types(name), profiles(full_name)")
      .single();
    if (error || !data) {
      toast.error(error?.message ?? "Failed to approve");
      return;
    }
    set(variations.map((x) => (x.id === v.id ? (data as any) : x)));
    toast.success("Variation approved");
  }

  async function reject(v: Variation) {
    const notes = pricing[v.id]?.notes ?? "";
    const { data, error } = await supabase
      .from("job_variations")
      .update({ status: "rejected", admin_notes: notes || null, approved_by: currentUserId, approved_at: new Date().toISOString() })
      .eq("id", v.id)
      .select("*, variation_types(name), profiles(full_name)")
      .single();
    if (error || !data) {
      toast.error(error?.message ?? "Failed to reject");
      return;
    }
    set(variations.map((x) => (x.id === v.id ? (data as any) : x)));
    toast.success("Variation rejected");
  }

  async function remove(id: string) {
    await supabase.from("job_variations").delete().eq("id", id);
    set(variations.filter((v) => v.id !== id));
  }

  const totalApprovedValue = variations
    .filter((v) => v.status === "auto_approved" || v.status === "approved")
    .reduce((sum, v) => sum + (Number(v.total_amount) || 0), 0);

  return (
    <div className="p-6 space-y-6">
      {totalApprovedValue > 0 && (
        <Card className="border-green-100 bg-green-50/40">
          <CardContent className="pt-4 pb-4 flex items-center justify-between">
            <p className="text-sm text-slate-600">Total approved variations</p>
            <p className="text-lg font-bold text-slate-800">${totalApprovedValue.toFixed(2)}</p>
          </CardContent>
        </Card>
      )}

      {variations.map((v) => {
        const s = STATUS_STYLE[v.status];
        const Icon = s.icon;
        return (
          <Card key={v.id}>
            <CardContent className="pt-4 pb-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-slate-800">{v.variation_types?.name ?? v.custom_name}</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {v.quantity} {v.unit}
                    {v.rate != null ? ` × $${Number(v.rate).toFixed(2)}` : ""}
                    {v.total_amount != null ? ` = $${Number(v.total_amount).toFixed(2)}` : ""}
                  </p>
                  {v.description && <p className="text-xs text-slate-400 mt-1">{v.description}</p>}
                  {v.photo_storage_path && (
                    <p className="text-xs text-slate-400 mt-1 flex items-center gap-1">
                      <ImageIcon className="w-3 h-3" /> Photo attached
                    </p>
                  )}
                  {v.profiles?.full_name && (
                    <p className="text-xs text-slate-400 mt-1">
                      Logged by {v.profiles.full_name}
                      {v.logged_at ? ` · ${new Date(v.logged_at).toLocaleDateString("en-AU")}` : ""}
                    </p>
                  )}
                  {v.admin_notes && <p className="text-xs text-slate-500 mt-1 italic">Office note: {v.admin_notes}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${s.bg} ${s.text}`}>
                    <Icon className="w-3.5 h-3.5" />
                    {s.label}
                  </span>
                  <button onClick={() => remove(v.id)} className="text-slate-300 hover:text-red-400 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {v.status === "pending_approval" && (
                <div className="border-t pt-3 grid grid-cols-3 gap-2 items-end">
                  <div className="space-y-1">
                    <Label className="text-xs">Quantity</Label>
                    <Input
                      className="h-8 text-sm"
                      defaultValue={v.quantity}
                      onChange={(e) => setPricing((p) => ({ ...p, [v.id]: { ...(p[v.id] ?? { rate: "", quantity: "", notes: "" }), quantity: e.target.value } }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Rate ($)</Label>
                    <Input
                      className="h-8 text-sm"
                      type="number"
                      step="0.01"
                      onChange={(e) => setPricing((p) => ({ ...p, [v.id]: { ...(p[v.id] ?? { rate: "", quantity: "", notes: "" }), rate: e.target.value } }))}
                      placeholder="Price from cost sheet"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" className="gap-1.5 bg-green-600 hover:bg-green-700 flex-1" onClick={() => priceAndApprove(v)}>
                      <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                    </Button>
                    <Button size="sm" variant="outline" className="gap-1.5 border-red-200 text-red-600 hover:bg-red-50 flex-1" onClick={() => reject(v)}>
                      <XCircle className="w-3.5 h-3.5" /> Reject
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      {variations.length === 0 && !showForm && (
        <Card>
          <CardContent className="py-10 text-center text-slate-400 text-sm">No variations logged for this job yet.</CardContent>
        </Card>
      )}

      {showForm ? (
        <Card>
          <CardHeader><CardTitle className="text-base">New Variation</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={addVariation} className="space-y-4">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={typeId} onValueChange={(v) => setTypeId(v ?? "custom")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="custom">Custom / Other (needs office approval)</SelectItem>
                    {variationTypes.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name} — ${Number(t.rate).toFixed(2)}/{t.unit} {t.auto_approve ? "(auto-approve)" : "(needs approval)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {typeId === "custom" && (
                <div className="space-y-1.5">
                  <Label>Name *</Label>
                  <Input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="e.g. Extra trenching due to rock" />
                </div>
              )}
              <div className="space-y-1.5">
                <Label>Quantity {selectedType ? `(${selectedType.unit})` : ""}</Label>
                <Input type="number" step="0.01" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="0" />
              </div>
              <div className="space-y-1.5">
                <Label>Description</Label>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What happened on site..." rows={2} />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
                <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Add Variation"}</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Button variant="outline" className="gap-2" onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4" /> Add Variation
        </Button>
      )}
    </div>
  );
}
