"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Trash2, Navigation, MapPin, Loader2, ShoppingCart, X } from "lucide-react";
import { nextJobPoNumber } from "@/lib/job-po-number";
import { siteOneLine, type JobSiteParts } from "@/lib/job-site";
import { planBuilderPo, planBuilderPoLines, type BuilderPoLineInput, type CostCentreOption } from "@/lib/builder-po";
import { BuilderPoLines, blankLine, type StageOption } from "@/components/job/builder-po-lines";

interface CostCenter {
  id: string;
  name: string;
  cost_centre_id?: string | null;
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

interface VendorOrder {
  id: string;
  cost_center_id: string;
  job_id: string;
  po_number: string;
  vendor_name: string;
  order_number: string | null;
  description: string | null;
  amount: number;
  gst_amount: number;
  status: "ordered" | "received" | "cancelled";
  order_date: string | null;
  notes: string | null;
  supplier_email?: string | null;
  emailed_at?: string | null;
  required_by?: string | null;
  delivery_address?: string | null;
  vendor_order_items?: { description: string; quantity: number; sort_order: number }[];
  profiles?: { full_name: string } | null;
}

interface ExpenseForAgg {
  cost_center_id: string | null;
  amount: number;
}

interface TimeEntryForAgg {
  cost_center_id: string | null;
  hours: number | null;
  entry_type?: "work" | "travel";
}

interface Props {
  jobId: string;
  jobNumber: number;
  customerName: string | null;
  site: (JobSiteParts & { site_lat?: number | null; site_lng?: number | null }) | null;
  pos: PurchaseOrder[];
  totalHoursLogged: number;
  onUpdate: (pos: PurchaseOrder[]) => void;
  overtimeReason?: string | null;
  overtimeCategory?: string | null;
  expenses: ExpenseForAgg[];
  timeEntries: TimeEntryForAgg[];
  vendorOrders: VendorOrder[];
  onVendorOrdersUpdate: (vendorOrders: VendorOrder[]) => void;
}

const VENDOR_ORDER_STATUS_LABELS: Record<VendorOrder["status"], string> = {
  ordered: "Ordered",
  received: "Received",
  cancelled: "Cancelled",
};

const VENDOR_ORDER_STATUS_COLORS: Record<VendorOrder["status"], string> = {
  ordered: "bg-amber-100 text-amber-700",
  received: "bg-green-100 text-green-700",
  cancelled: "bg-slate-100 text-slate-400 line-through",
};

function progressColor(pct: number) {
  if (pct >= 95) return "bg-red-500";
  if (pct >= 75) return "bg-orange-400";
  return "bg-green-500";
}

export function JobPO({ jobId, jobNumber, customerName, site, pos: initialPos, totalHoursLogged, onUpdate, overtimeReason, overtimeCategory, expenses, timeEntries, vendorOrders: initialVendorOrders, onVendorOrdersUpdate }: Props) {
  const supabase = createClient();
  const [pos, setPos] = useState<PurchaseOrder[]>(initialPos);
  const [vendorOrders, setVendorOrders] = useState<VendorOrder[]>(initialVendorOrders);
  const [voFormOpenFor, setVoFormOpenFor] = useState<string | null>(null);
  const [voSaving, setVoSaving] = useState(false);
  const [voForm, setVoForm] = useState({ vendor_name: "", order_number: "", amount: "", order_date: "", notes: "" });
  const [showForm, setShowForm] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newPO, setNewPO] = useState({ po_number: "", client_reference: "", site_address: "" });
  // The builder's PO value and its split across company cost centres
  // (lib/builder-po.ts; Justin, 31 Oct 2026).
  const [poValue, setPoValue] = useState("");
  const [poLines, setPoLines] = useState<BuilderPoLineInput[]>([blankLine()]);
  const [costCentreOptions, setCostCentreOptions] = useState<CostCentreOption[]>([]);
  const [costCentresFailed, setCostCentresFailed] = useState(false);
  const [geocoded, setGeocoded] = useState<{ lat: number; lng: number; display: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [stages, setStages] = useState<StageOption[]>([]);
  const [addLinesFor, setAddLinesFor] = useState<string | null>(null);
  const [addLines, setAddLines] = useState<BuilderPoLineInput[]>([blankLine()]);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    supabase
      .from("cost_center_templates")
      .select("name, cost_centre_id")
      .eq("is_active", true)
      .order("sort_order")
      .then(({ data }) => setStages((data as StageOption[]) ?? []));
    supabase
      .from("cost_centres")
      .select("id, name")
      .eq("is_active", true)
      .order("sort_order")
      .then(({ data, error }) => {
        if (error) console.error("cost centres load failed:", error);
        setCostCentresFailed(!!error);
        setCostCentreOptions((data as CostCentreOption[]) ?? []);
      });
    supabase
      .from("suppliers")
      .select("id, name")
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => setSuppliers((data as { id: string; name: string }[]) ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function fieldErr(field: string) {
    return errors[field] ? "border-red-500 focus-visible:ring-red-500" : "";
  }

  // A new PO starts filled in from the job: the next number (4321-1, -2, ...),
  // the client, and the site, already pinned when the site has coordinates.
  // All three stay editable.
  function openNewPO() {
    const address = siteOneLine(site);
    setNewPO({
      po_number: nextJobPoNumber(jobNumber, pos.map(p => p.po_number)),
      client_reference: customerName ?? "",
      site_address: address,
    });
    setGeocoded(
      address && site?.site_lat != null && site?.site_lng != null
        ? { lat: Number(site.site_lat), lng: Number(site.site_lng), display: address }
        : null
    );
    setPoValue("");
    setPoLines([blankLine()]);
    setErrors({});
    setShowForm(true);
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
    const planned = planBuilderPo({ value: poValue, lines: poLines }, costCentreOptions);
    if (!planned.ok) { toast.error(planned.error); return; }
    setSaving(true);

    const { data: po, error } = await supabase.from("purchase_orders").insert({
      job_id: jobId,
      po_number: newPO.po_number.trim(),
      client_reference: newPO.client_reference || null,
      site_address: newPO.site_address || null,
      site_lat: geocoded?.lat ?? null,
      site_lng: geocoded?.lng ?? null,
      total_value: planned.po.value,
      total_hours: planned.po.totalHours,
    }).select().single();

    if (error || !po) { toast.error("Failed to save PO"); setSaving(false); return; }

    if (planned.po.lines.length > 0) {
      const { error: centersError } = await supabase.from("po_cost_centers").insert(
        planned.po.lines.map((l) => ({ ...l, po_id: po.id }))
      );

      // Cost centres carry the allocated dollars and hours this PO is measured
      // against, so a PO saved without them reports zero allocation and every
      // budget figure derived from it is wrong. The PO itself is real, so the
      // message says so rather than pretending nothing was written.
      if (centersError) {
        toast.error(`Purchase order saved, but its cost centres did not: ${centersError.message}`);
      }
    }

    await refreshPO(po.id);
    setShowForm(false);
    setNewPO({ po_number: "", client_reference: "", site_address: "" });
    setPoValue("");
    setPoLines([blankLine()]);
    setGeocoded(null);
    toast.success(planned.po.unallocated > 0 ? "Purchase order saved — part of its value isn't split yet" : "Purchase order saved");
    setSaving(false);
  }

  // Re-reads one PO with its lines and puts it in place (or on the end).
  async function refreshPO(poId: string) {
    const { data: freshPO } = await supabase
      .from("purchase_orders")
      .select("*, po_cost_centers(*)")
      .eq("id", poId)
      .single();
    if (!freshPO) return;
    const fresh = freshPO as PurchaseOrder;
    const updated = pos.some((p) => p.id === poId) ? pos.map((p) => (p.id === poId ? fresh : p)) : [...pos, fresh];
    setPos(updated);
    onUpdate(updated);
  }

  // Tags an existing line with a company cost centre — mostly Simpro lines the
  // 0087 keyword match couldn't place.
  async function setLineCostCentre(lineId: string, poId: string, costCentreId: string) {
    const { error, count } = await supabase
      .from("po_cost_centers")
      .update({ cost_centre_id: costCentreId || null }, { count: "exact" })
      .eq("id", lineId);
    if (error || count === 0) { toast.error("Couldn't set the cost centre."); return; }
    await refreshPO(poId);
  }

  // The PO's value as the builder wrote it. Lines are not touched.
  async function setPOValue(po: PurchaseOrder, raw: string) {
    const value = Math.round((Number(raw.replace(/[$,\s]/g, "")) || 0) * 100) / 100;
    if (value === Number(po.total_value)) return;
    const { error, count } = await supabase
      .from("purchase_orders")
      .update({ total_value: value }, { count: "exact" })
      .eq("id", po.id);
    if (error || count === 0) { toast.error("Couldn't change the PO value."); return; }
    await refreshPO(po.id);
  }

  // Adds split lines to a PO that already exists (a quote total to split, or
  // a stage the builder added).
  async function saveAddedLines(po: PurchaseOrder) {
    const planned = planBuilderPoLines(addLines, costCentreOptions);
    if (!planned.ok) { toast.error(planned.error); return; }
    if (planned.lines.length === 0) { setAddLinesFor(null); return; }
    const start = po.po_cost_centers?.length ?? 0;
    const { error } = await supabase.from("po_cost_centers").insert(
      planned.lines.map((l, i) => ({ ...l, po_id: po.id, sort_order: start + i }))
    );
    if (error) { toast.error("Couldn't add the cost centres."); return; }
    const hours = Number(po.total_hours || 0) + planned.totalHours;
    if (planned.totalHours > 0) {
      // The lines are saved either way; only the PO's hours total would be stale.
      const { error: hoursError } = await supabase.from("purchase_orders").update({ total_hours: hours }).eq("id", po.id);
      if (hoursError) toast.error("Cost centres added, but the PO's hours total didn't update.");
    }
    setAddLinesFor(null);
    setAddLines([blankLine()]);
    await refreshPO(po.id);
  }

  async function deletePO(poId: string) {
    // No error for a DELETE that matches nothing, so `count` is what
    // distinguishes "removed" from "refused" — and this row is what the job's
    // budget is measured against.
    const { error, count } = await supabase
      .from("purchase_orders")
      .delete({ count: "exact" })
      .eq("id", poId);
    if (error || count === 0) {
      toast.error(error?.message ?? "Could not remove this purchase order.");
      return;
    }
    const updated = pos.filter(p => p.id !== poId);
    setPos(updated);
    onUpdate(updated);
    toast.success("PO removed");
  }

  async function saveVendorOrder(costCenterId: string) {
    if (!voForm.vendor_name.trim()) { toast.error("Vendor name is required"); return; }
    setVoSaving(true);
    // A name picked from the supplier list links the order to that supplier
    // (0087); anything else is a one-off, kept by name only.
    const picked = suppliers.find((s) => s.name.toLowerCase() === voForm.vendor_name.trim().toLowerCase());
    const { data, error } = await supabase.from("vendor_orders").insert({
      cost_center_id: costCenterId,
      job_id: jobId,
      vendor_name: picked?.name ?? voForm.vendor_name.trim(),
      supplier_id: picked?.id ?? null,
      order_number: voForm.order_number || null,
      amount: parseFloat(voForm.amount) || 0,
      order_date: voForm.order_date || null,
      notes: voForm.notes || null,
    }).select("*, vendor_order_items(description, quantity, sort_order), profiles(full_name)").single();

    if (error || !data) { toast.error("Failed to save vendor order"); setVoSaving(false); return; }

    const updated = [data as VendorOrder, ...vendorOrders];
    setVendorOrders(updated);
    onVendorOrdersUpdate(updated);
    setVoFormOpenFor(null);
    setVoForm({ vendor_name: "", order_number: "", amount: "", order_date: "", notes: "" });
    toast.success("Vendor order raised");
    setVoSaving(false);
  }

  async function updateVendorOrderStatus(id: string, status: VendorOrder["status"]) {
    const { error } = await supabase.from("vendor_orders").update({ status }).eq("id", id);
    if (error) { toast.error("Failed to update status"); return; }
    const updated = vendorOrders.map(v => v.id === id ? { ...v, status } : v);
    setVendorOrders(updated);
    onVendorOrdersUpdate(updated);
  }

  async function updateVendorOrder(id: string, patch: { amount: number }) {
    const { error } = await supabase.from("vendor_orders").update(patch).eq("id", id);
    if (error) { toast.error("Failed to update order"); return; }
    const updated = vendorOrders.map(v => v.id === id ? { ...v, ...patch } : v);
    setVendorOrders(updated);
    onVendorOrdersUpdate(updated);
  }

  async function deleteVendorOrder(id: string) {
    const { error, count } = await supabase.from("vendor_orders").delete({ count: "exact" }).eq("id", id);
    if (error || count === 0) { toast.error(error?.message ?? "Could not remove this vendor order."); return; }
    const updated = vendorOrders.filter(v => v.id !== id);
    setVendorOrders(updated);
    onVendorOrdersUpdate(updated);
    toast.success("Vendor order removed");
  }

  const vendorOrdersByCostCenter: Record<string, VendorOrder[]> = {};
  for (const vo of vendorOrders) {
    (vendorOrdersByCostCenter[vo.cost_center_id] ??= []).push(vo);
  }
  const committedByCostCenter: Record<string, number> = {};
  for (const vo of vendorOrders) {
    if (vo.status === "cancelled") continue;
    committedByCostCenter[vo.cost_center_id] = (committedByCostCenter[vo.cost_center_id] ?? 0) + (Number(vo.amount) || 0);
  }

  const totalAllocatedHours = pos.reduce((sum, p) => sum + (Number(p.total_hours) || 0), 0);
  const totalAllocatedValue = pos.reduce((sum, p) => sum + (Number(p.total_value) || 0), 0);
  const hoursPct = totalAllocatedHours > 0 ? Math.min((totalHoursLogged / totalAllocatedHours) * 100, 100) : 0;

  // Actual spend/hours per cost centre (stage), so budgeted vs. actual can
  // be compared stage-by-stage instead of only for the job as a whole.
  const spentByCostCenter: Record<string, number> = {};
  for (const e of expenses) {
    if (!e.cost_center_id) continue;
    spentByCostCenter[e.cost_center_id] = (spentByCostCenter[e.cost_center_id] ?? 0) + (Number(e.amount) || 0);
  }
  const hoursByCostCenter: Record<string, number> = {};
  for (const t of timeEntries) {
    if (!t.cost_center_id || t.entry_type === "travel") continue;
    hoursByCostCenter[t.cost_center_id] = (hoursByCostCenter[t.cost_center_id] ?? 0) + (Number(t.hours) || 0);
  }

  // One supplier order. Tech-raised ones arrive with a PO number, lines and
  // no price — the amount is typed here from the supplier invoice.
  function renderVendorOrder(vo: VendorOrder) {
    const items = [...(vo.vendor_order_items ?? [])].sort((a, b) => a.sort_order - b.sort_order);
    return (
      <div key={vo.id} className="rounded border border-slate-100 bg-slate-50/60 px-2 py-1.5 text-xs space-y-1">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="font-mono font-semibold text-slate-800">{vo.po_number}</span>
            <span className="font-medium text-slate-700"> · {vo.vendor_name}</span>
            {vo.order_number && <span className="text-slate-400 font-mono"> · {vo.order_number}</span>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-slate-400">$</span>
            <input
              key={`${vo.id}-${vo.amount}`}
              type="number" step="0.01" min="0"
              defaultValue={Number(vo.amount) ? Number(vo.amount).toFixed(2) : ""}
              placeholder="ex GST"
              title="Amount ex GST, from the supplier invoice"
              onBlur={e => {
                const amount = parseFloat(e.target.value) || 0;
                if (amount !== Number(vo.amount)) updateVendorOrder(vo.id, { amount });
              }}
              className="w-20 rounded border border-slate-200 bg-white px-1 py-0.5 text-right text-slate-700"
            />
            <select
              value={vo.status}
              onChange={e => updateVendorOrderStatus(vo.id, e.target.value as VendorOrder["status"])}
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium border-0 ${VENDOR_ORDER_STATUS_COLORS[vo.status]}`}
            >
              {(Object.keys(VENDOR_ORDER_STATUS_LABELS) as VendorOrder["status"][]).map(s => (
                <option key={s} value={s}>{VENDOR_ORDER_STATUS_LABELS[s]}</option>
              ))}
            </select>
            <button onClick={() => deleteVendorOrder(vo.id)} className="text-slate-300 hover:text-red-400 transition-colors">
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </div>
        {items.length > 0 && (
          <p className="text-slate-600">{items.map(i => `${Number(i.quantity)} × ${i.description}`).join(", ")}</p>
        )}
        <p className="text-slate-400">
          {[
            vo.profiles?.full_name ? `Raised by ${vo.profiles.full_name}` : null,
            vo.order_date,
            vo.required_by ? `needed ${vo.required_by}` : null,
            vo.emailed_at ? `emailed to ${vo.supplier_email}` : vo.supplier_email ? `email to ${vo.supplier_email} FAILED` : null,
          ].filter(Boolean).join(" · ")}
        </p>
      </div>
    );
  }

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
                <label className="flex items-center gap-1.5 text-xs text-slate-500 mt-1">
                  Value $
                  <input
                    key={`${po.id}-value-${po.total_value}`}
                    inputMode="decimal"
                    defaultValue={Number(po.total_value || 0).toFixed(2)}
                    onBlur={e => setPOValue(po, e.target.value)}
                    title="The PO's value ex GST, as the builder wrote it (or the quote total)"
                    className="w-28 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-right text-slate-800"
                  />
                  ex GST
                </label>
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
          {(() => {
            const lines = po.po_cost_centers ?? [];
            const unsplit = Math.round((Number(po.total_value || 0) - lines.reduce((s, l) => s + (Number(l.allocated_amount) || 0), 0)) * 100) / 100;
            return (
            <CardContent className="pt-0 space-y-3">
              {lines.map(cc => {
                const spent = spentByCostCenter[cc.id] ?? 0;
                const hoursLogged = hoursByCostCenter[cc.id] ?? 0;
                const allocatedAmount = Number(cc.allocated_amount) || 0;
                const allocatedHours = Number(cc.allocated_hours) || 0;
                const dollarPct = allocatedAmount > 0 ? Math.min((spent / allocatedAmount) * 100, 100) : 0;
                const stageHoursPct = allocatedHours > 0 ? Math.min((hoursLogged / allocatedHours) * 100, 100) : 0;
                const committed = committedByCostCenter[cc.id] ?? 0;
                const committedPct = allocatedAmount > 0 ? Math.min((committed / allocatedAmount) * 100, 100) : 0;
                const ccVendorOrders = vendorOrdersByCostCenter[cc.id] ?? [];
                return (
                  <div key={cc.id} className="rounded-lg border border-slate-100 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-800">
                        {cc.name}
                        {cc.code && <span className="ml-2 text-xs text-slate-400 font-mono font-normal">{cc.code}</span>}
                      </p>
                      <select
                        value={cc.cost_centre_id ?? ""}
                        onChange={e => setLineCostCentre(cc.id, po.id, e.target.value)}
                        title="Company cost centre"
                        className={`h-7 rounded border bg-white px-1.5 text-xs ${cc.cost_centre_id ? "border-slate-200 text-slate-600" : "border-orange-300 text-orange-700"}`}
                      >
                        <option value="">Set cost centre…</option>
                        {costCentreOptions.map(c => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div className="flex justify-between text-xs text-slate-500 mb-1">
                        <span>${spent.toFixed(2)} spent</span>
                        <span>${allocatedAmount.toFixed(2)} allocated</span>
                      </div>
                      <div className="w-full bg-slate-200 rounded-full h-2">
                        <div className={`h-2 rounded-full ${progressColor(dollarPct)}`} style={{ width: `${dollarPct}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-xs text-slate-500 mb-1">
                        <span>{hoursLogged.toFixed(1)}h logged</span>
                        <span>{allocatedHours.toFixed(1)}h allocated</span>
                      </div>
                      <div className="w-full bg-slate-200 rounded-full h-2">
                        <div className={`h-2 rounded-full ${progressColor(stageHoursPct)}`} style={{ width: `${stageHoursPct}%` }} />
                      </div>
                    </div>
                    {allocatedAmount > 0 && (
                      <div>
                        <div className="flex justify-between text-xs text-slate-500 mb-1">
                          <span>${committed.toFixed(2)} committed</span>
                          <span>${allocatedAmount.toFixed(2)} allocated</span>
                        </div>
                        <div className="w-full bg-slate-200 rounded-full h-2">
                          <div className="h-2 rounded-full bg-sky-400" style={{ width: `${committedPct}%` }} />
                        </div>
                      </div>
                    )}

                    {/* Vendor Orders */}
                    <div className="pt-1 space-y-1.5">
                      {ccVendorOrders.map(vo => renderVendorOrder(vo))}

                      {voFormOpenFor === cc.id ? (
                        <div className="rounded border border-slate-200 p-2 space-y-2">
                          <datalist id="po-supplier-list">
                            {suppliers.map((s) => <option key={s.id} value={s.name} />)}
                          </datalist>
                          <div className="grid grid-cols-2 gap-2">
                            <Input
                              value={voForm.vendor_name}
                              onChange={e => setVoForm(p => ({ ...p, vendor_name: e.target.value }))}
                              placeholder="Supplier *"
                              className="text-xs h-7"
                              list="po-supplier-list"
                            />
                            <Input
                              value={voForm.order_number}
                              onChange={e => setVoForm(p => ({ ...p, order_number: e.target.value }))}
                              placeholder="Order #"
                              className="text-xs h-7 font-mono"
                            />
                            <Input
                              type="number" step="0.01"
                              value={voForm.amount}
                              onChange={e => setVoForm(p => ({ ...p, amount: e.target.value }))}
                              placeholder="$ Amount"
                              className="text-xs h-7"
                            />
                            <Input
                              type="date"
                              value={voForm.order_date}
                              onChange={e => setVoForm(p => ({ ...p, order_date: e.target.value }))}
                              className="text-xs h-7"
                            />
                          </div>
                          <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setVoFormOpenFor(null); setVoForm({ vendor_name: "", order_number: "", amount: "", order_date: "", notes: "" }); }}>
                              <X className="w-3 h-3" />
                            </Button>
                            <Button type="button" size="sm" className="h-7 text-xs" onClick={() => saveVendorOrder(cc.id)} disabled={voSaving}>
                              {voSaving ? "Saving..." : "Save"}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setVoFormOpenFor(cc.id)}
                          className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 transition-colors"
                        >
                          <ShoppingCart className="w-3 h-3" />Raise Vendor Order
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {unsplit !== 0 && (
                <p className={`text-xs font-medium ${unsplit > 0 ? "text-orange-600" : "text-red-600"}`}>
                  {unsplit > 0
                    ? `$${unsplit.toFixed(2)} of this PO isn't split across cost centres yet.`
                    : `The cost centres add up to $${(-unsplit).toFixed(2)} more than the PO value.`}
                </p>
              )}
              {addLinesFor === po.id ? (
                <div className="rounded-lg border border-dashed border-slate-200 p-3 space-y-2">
                  <BuilderPoLines
                    value={unsplit > 0 ? unsplit.toFixed(2) : ""}
                    lines={addLines}
                    onChange={setAddLines}
                    costCentres={costCentreOptions}
                    stages={stages}
                    loadError={costCentresFailed}
                    onCostCentreAdded={(c) => setCostCentreOptions((prev) => [...prev, c])}
                  />
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setAddLinesFor(null); setAddLines([blankLine()]); }}>Cancel</Button>
                    <Button type="button" size="sm" className="h-7 text-xs" onClick={() => saveAddedLines(po)}>Add</Button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => { setAddLinesFor(po.id); setAddLines([{ ...blankLine(), amount: unsplit > 0 ? unsplit.toFixed(2) : "" }]); }}
                  className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition-colors"
                >
                  <Plus className="w-3 h-3" />Add cost centre to this PO
                </button>
              )}
              <div className="flex justify-between text-sm pt-2 border-t font-semibold text-slate-800">
                <span>PO Total</span>
                <span>${Number(po.total_value).toFixed(2)} · {Number(po.total_hours).toFixed(1)}h</span>
              </div>
            </CardContent>
            );
          })()}
        </Card>
      ))}

      {/* Add PO Form */}
      {showForm ? (
        <Card>
          <CardHeader><CardTitle className="text-base">New Purchase Order</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Builder&apos;s PO number *</Label>
                <Input
                  value={newPO.po_number}
                  onChange={e => { setNewPO(p => ({ ...p, po_number: e.target.value })); setErrors({}); }}
                  placeholder={`e.g. ${jobNumber}-1`}
                  className={fieldErr("po_number")}
                />
                {errors.po_number
                  ? <p className="text-xs text-red-500">PO number is required</p>
                  : <p className="text-xs text-slate-400">For quoted work with no builder PO, keep the job number.</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Client</Label>
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

            <div className="space-y-1.5">
              <Label>PO value (ex GST) *</Label>
              <Input
                inputMode="decimal"
                value={poValue}
                onChange={e => setPoValue(e.target.value)}
                placeholder="What the builder's PO (or the quote) is for"
                className="max-w-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Split across cost centres</Label>
              <p className="text-xs text-slate-400">
                Each cost centre&apos;s share is its budget. A drainage PO usually splits between Below Ground Drainage and
                Transport. You can save now and split the rest later.
              </p>
              <BuilderPoLines
                value={poValue}
                lines={poLines}
                onChange={setPoLines}
                costCentres={costCentreOptions}
                stages={stages}
                loadError={costCentresFailed}
                onCostCentreAdded={(c) => setCostCentreOptions((prev) => [...prev, c])}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => { setShowForm(false); setGeocoded(null); setPoValue(""); setPoLines([blankLine()]); }}>Cancel</Button>
              <Button type="button" onClick={savePO} disabled={saving}>
                {saving ? "Saving..." : "Save PO"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Button variant="outline" className="gap-2" onClick={openNewPO}>
          <Plus className="w-4 h-4" />Add Purchase Order
        </Button>
      )}
    </div>
  );
}
