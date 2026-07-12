"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Trash2, Navigation, MapPin, Loader2 } from "lucide-react";

interface CostCenter {
  id: string;
  name: string;
  code: string | null;
  allocated_amount: number;
  allocated_hours: number;
}

interface PurchaseOrder {
  id: string;
  po_number: string;
  client_reference: string | null;
  site_address: string | null;
  site_lat: number | null;
  site_lng: number | null;
  total_value: number;
  total_hours: number;
  po_cost_centers: CostCenter[];
}

const OVERTIME_LABELS: Record<string, string> = {
  unexpected_issue: "Unexpected issue",
  difficult_site: "Difficult site",
  training_needed: "Training needed",
  other: "Other",
};

interface Props {
  jobId: string;
  pos: PurchaseOrder[];
  totalHoursLogged: number;
  onUpdate: (pos: PurchaseOrder[]) => void;
  overtimeReason?: string | null;
  overtimeCategory?: string | null;
}

function progressColor(pct: number) {
  if (pct >= 95) return "bg-red-500";
  if (pct >= 75) return "bg-orange-400";
  return "bg-green-500";
}

export function JobPO({ jobId, pos: initialPos, totalHoursLogged, onUpdate, overtimeReason, overtimeCategory }: Props) {
  const supabase = createClient();
  const [pos, setPos] = useState<PurchaseOrder[]>(initialPos);
  const [showForm, setShowForm] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newPO, setNewPO] = useState({ po_number: "", client_reference: "", site_address: "" });
  const [costCenters, setCostCenters] = useState([{ name: "", code: "", allocated_amount: "", allocated_hours: "" }]);
  const [geocoded, setGeocoded] = useState<{ lat: number; lng: number; display: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, boolean>>({});

  function fieldErr(field: string) {
    return errors[field] ? "border-red-500 focus-visible:ring-red-500" : "";
  }

  async function geocodeAddress() {
    if (!newPO.site_address.trim()) return;
    setGeocoding(true);
    try {
      const res = await fetch(`/api/geocode?address=${encodeURIComponent(newPO.site_address)}`);
      const data = await res.json();
      if (res.ok) {
        setGeocoded(data);
        toast.success("Address confirmed");
      } else {
        toast.error("Address not found — check the address and try again");
      }
    } catch {
      toast.error("Geocoding failed");
    }
    setGeocoding(false);
  }

  async function savePO() {
    if (!newPO.po_number.trim()) { setErrors({ po_number: true }); return; }
    setSaving(true);

    const totalValue = costCenters.reduce((sum, c) => sum + (parseFloat(c.allocated_amount) || 0), 0);
    const totalHours = costCenters.reduce((sum, c) => sum + (parseFloat(c.allocated_hours) || 0), 0);

    const { data: po, error } = await supabase.from("purchase_orders").insert({
      job_id: jobId,
      po_number: newPO.po_number,
      client_reference: newPO.client_reference || null,
      site_address: newPO.site_address || null,
      site_lat: geocoded?.lat ?? null,
      site_lng: geocoded?.lng ?? null,
      total_value: totalValue,
      total_hours: totalHours,
    }).select().single();

    if (error || !po) { toast.error("Failed to save PO"); setSaving(false); return; }

    const validCenters = costCenters.filter(c => c.name.trim());
    if (validCenters.length > 0) {
      await supabase.from("po_cost_centers").insert(
        validCenters.map((c, i) => ({
          po_id: po.id,
          name: c.name,
          code: c.code || null,
          allocated_amount: parseFloat(c.allocated_amount) || 0,
          allocated_hours: parseFloat(c.allocated_hours) || 0,
          sort_order: i,
        }))
      );
    }

    const { data: freshPO } = await supabase
      .from("purchase_orders")
      .select("*, po_cost_centers(*)")
      .eq("id", po.id)
      .single();

    const updated = [...pos, freshPO as PurchaseOrder];
    setPos(updated);
    onUpdate(updated);
    setShowForm(false);
    setNewPO({ po_number: "", client_reference: "", site_address: "" });
    setCostCenters([{ name: "", code: "", allocated_amount: "", allocated_hours: "" }]);
    setGeocoded(null);
    toast.success("Purchase order saved");
    setSaving(false);
  }

  async function deletePO(poId: string) {
    await supabase.from("purchase_orders").delete().eq("id", poId);
    const updated = pos.filter(p => p.id !== poId);
    setPos(updated);
    onUpdate(updated);
    toast.success("PO removed");
  }

  const totalAllocatedHours = pos.reduce((sum, p) => sum + (Number(p.total_hours) || 0), 0);
  const totalAllocatedValue = pos.reduce((sum, p) => sum + (Number(p.total_value) || 0), 0);
  const hoursPct = totalAllocatedHours > 0 ? Math.min((totalHoursLogged / totalAllocatedHours) * 100, 100) : 0;

  return (
    <div className="p-6 space-y-6">
      {/* Scoreboard */}
      {totalAllocatedHours > 0 && (
        <Card className="border-blue-100 bg-blue-50/40">
          <CardContent className="pt-4 pb-4 space-y-3">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Hours Scoreboard</p>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm text-slate-600">Time used</span>
                <span className={`text-sm font-bold ${hoursPct >= 95 ? "text-red-600" : hoursPct >= 75 ? "text-orange-500" : "text-green-600"}`}>
                  {totalHoursLogged.toFixed(1)}h / {totalAllocatedHours.toFixed(1)}h
                </span>
              </div>
              <div className="w-full bg-slate-200 rounded-full h-3">
                <div
                  className={`h-3 rounded-full transition-all ${progressColor(hoursPct)}`}
                  style={{ width: `${hoursPct}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-slate-400 mt-1">
                <span>{hoursPct.toFixed(0)}% of budget used</span>
                <span>{Math.max(0, totalAllocatedHours - totalHoursLogged).toFixed(1)}h remaining</span>
              </div>
            </div>
            <div className="flex justify-between text-sm pt-1 border-t">
              <span className="text-slate-500">Total PO value</span>
              <span className="font-semibold text-slate-800">${totalAllocatedValue.toFixed(2)}</span>
            </div>
            {overtimeCategory && (
              <div className="pt-2 border-t">
                <p className="text-xs font-semibold text-red-600 uppercase tracking-wide">Overtime reason logged</p>
                <p className="text-sm text-slate-700 mt-1">
                  {OVERTIME_LABELS[overtimeCategory] ?? overtimeCategory}
                  {overtimeReason ? ` — ${overtimeReason}` : ""}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* PO List */}
      {pos.map(po => (
        <Card key={po.id}>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="text-base">PO #{po.po_number}</CardTitle>
                {po.client_reference && <p className="text-xs text-slate-500 mt-0.5">Ref: {po.client_reference}</p>}
                {po.site_address && (
                  <p className="text-xs text-slate-400 flex items-center gap-1 mt-1">
                    <MapPin className="w-3 h-3 shrink-0" />{po.site_address}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {po.site_lat && po.site_lng && (
                  <a href={`https://waze.com/ul?ll=${po.site_lat},${po.site_lng}&navigate=yes`} target="_blank" rel="noopener noreferrer">
                    <Button variant="outline" size="sm" className="gap-1.5 text-blue-600 border-blue-200 hover:bg-blue-50 h-8 text-xs">
                      <Navigation className="w-3.5 h-3.5" />Waze
                    </Button>
                  </a>
                )}
                <button onClick={() => deletePO(po.id)} className="text-slate-300 hover:text-red-400 transition-colors p-1">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </CardHeader>
          {po.po_cost_centers && po.po_cost_centers.length > 0 && (
            <CardContent className="pt-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left pb-2 font-medium text-slate-400 text-xs">Cost Centre</th>
                    <th className="text-left pb-2 font-medium text-slate-400 text-xs">Code</th>
                    <th className="text-right pb-2 font-medium text-slate-400 text-xs">$ Allocated</th>
                    <th className="text-right pb-2 font-medium text-slate-400 text-xs">Hours</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {po.po_cost_centers.map(cc => (
                    <tr key={cc.id}>
                      <td className="py-2 font-medium text-slate-800">{cc.name}</td>
                      <td className="py-2 text-slate-400 text-xs font-mono">{cc.code}</td>
                      <td className="py-2 text-right text-slate-700">${Number(cc.allocated_amount).toFixed(2)}</td>
                      <td className="py-2 text-right text-slate-700">{Number(cc.allocated_hours).toFixed(1)}h</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t">
                    <td colSpan={2} className="pt-2 text-sm font-semibold text-slate-800">Total</td>
                    <td className="pt-2 text-right font-semibold text-slate-800">${Number(po.total_value).toFixed(2)}</td>
                    <td className="pt-2 text-right font-semibold text-slate-800">{Number(po.total_hours).toFixed(1)}h</td>
                  </tr>
                </tfoot>
              </table>
            </CardContent>
          )}
        </Card>
      ))}

      {/* Add PO Form */}
      {showForm ? (
        <Card>
          <CardHeader><CardTitle className="text-base">New Purchase Order</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>PO Number *</Label>
                <Input
                  value={newPO.po_number}
                  onChange={e => { setNewPO(p => ({ ...p, po_number: e.target.value })); setErrors({}); }}
                  placeholder="e.g. PO-12345"
                  className={fieldErr("po_number")}
                />
                {errors.po_number && <p className="text-xs text-red-500">PO number is required</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Client Reference</Label>
                <Input
                  value={newPO.client_reference}
                  onChange={e => setNewPO(p => ({ ...p, client_reference: e.target.value }))}
                  placeholder="Optional"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Site Address</Label>
              <div className="flex gap-2">
                <Input
                  value={newPO.site_address}
                  onChange={e => { setNewPO(p => ({ ...p, site_address: e.target.value })); setGeocoded(null); }}
                  placeholder="123 Main St, Suburb, QLD"
                  className="flex-1"
                  onBlur={geocodeAddress}
                />
                <Button type="button" variant="outline" size="icon" onClick={geocodeAddress} disabled={geocoding || !newPO.site_address.trim()}>
                  {geocoding ? <Loader2 className="w-4 h-4 animate-spin" /> : <MapPin className="w-4 h-4" />}
                </Button>
              </div>
              {geocoded && (
                <p className="text-xs text-green-600 flex items-center gap-1.5">
                  <MapPin className="w-3 h-3" />Confirmed: {geocoded.display.split(",").slice(0, 3).join(",")}
                </p>
              )}
              {!geocoded && newPO.site_address && (
                <p className="text-xs text-slate-400">Click the pin icon to confirm the address for Waze and geo-fencing</p>
              )}
            </div>

            {/* Cost Centres */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>Cost Centres</Label>
                <Button
                  type="button" variant="ghost" size="sm"
                  className="gap-1 h-7 text-xs"
                  onClick={() => setCostCenters(p => [...p, { name: "", code: "", allocated_amount: "", allocated_hours: "" }])}
                >
                  <Plus className="w-3 h-3" />Add Row
                </Button>
              </div>
              <div className="space-y-2">
                <div className="grid grid-cols-12 gap-2 text-xs text-slate-400 font-medium px-1">
                  <span className="col-span-4">Name</span>
                  <span className="col-span-3">Code</span>
                  <span className="col-span-2 text-right">$ Amount</span>
                  <span className="col-span-2 text-right">Hours</span>
                </div>
                {costCenters.map((cc, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-4">
                      <Input
                        value={cc.name}
                        onChange={e => setCostCenters(p => p.map((c, j) => j === i ? { ...c, name: e.target.value } : c))}
                        placeholder="e.g. Labour"
                        className="text-sm h-8"
                      />
                    </div>
                    <div className="col-span-3">
                      <Input
                        value={cc.code}
                        onChange={e => setCostCenters(p => p.map((c, j) => j === i ? { ...c, code: e.target.value } : c))}
                        placeholder="LAB01"
                        className="text-sm h-8 font-mono"
                      />
                    </div>
                    <div className="col-span-2">
                      <Input
                        type="number" step="0.01"
                        value={cc.allocated_amount}
                        onChange={e => setCostCenters(p => p.map((c, j) => j === i ? { ...c, allocated_amount: e.target.value } : c))}
                        placeholder="0.00"
                        className="text-sm h-8 text-right"
                      />
                    </div>
                    <div className="col-span-2">
                      <Input
                        type="number" step="0.5"
                        value={cc.allocated_hours}
                        onChange={e => setCostCenters(p => p.map((c, j) => j === i ? { ...c, allocated_hours: e.target.value } : c))}
                        placeholder="0"
                        className="text-sm h-8 text-right"
                      />
                    </div>
                    <div className="col-span-1 flex justify-end">
                      <button
                        type="button"
                        onClick={() => setCostCenters(p => p.filter((_, j) => j !== i))}
                        className="text-slate-300 hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => { setShowForm(false); setGeocoded(null); }}>Cancel</Button>
              <Button type="button" onClick={savePO} disabled={saving}>
                {saving ? "Saving..." : "Save PO"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Button variant="outline" className="gap-2" onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4" />Add Purchase Order
        </Button>
      )}
    </div>
  );
}
