"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2 } from "lucide-react";
import { computeLoadedCost, LEAVE_TYPE_LABELS, type StaffCostInputs } from "@/lib/staff-cost";
import { formatDate } from "@/lib/date";

interface LeaveEntry {
  id: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  hours: number;
  notes: string | null;
}

const emptyCostForm: StaffCostInputs = {
  hourly_rate: 0,
  super_rate: 11.5,
  workers_comp_rate: 0,
  leave_loading_rate: 0,
  annual_fixed_oncosts: 0,
  target_hours_per_week: 38,
};

const emptyLeaveForm = { leave_type: "sick", start_date: "", end_date: "", hours: "", notes: "" };

interface Props {
  staffId: string;
  staffName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function StaffCostDialog({ staffId, staffName, open, onOpenChange }: Props) {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [costForm, setCostForm] = useState<StaffCostInputs>(emptyCostForm);
  const [leaveEntries, setLeaveEntries] = useState<LeaveEntry[]>([]);
  const [leaveForm, setLeaveForm] = useState(emptyLeaveForm);
  const [addingLeave, setAddingLeave] = useState(false);

  useEffect(() => {
    if (!open) return;
    async function load() {
      setLoading(true);
      const [{ data: profile }, { data: leave }] = await Promise.all([
        supabase.from("staff_cost_profiles").select("*").eq("staff_id", staffId).maybeSingle(),
        supabase.from("staff_leave").select("*").eq("staff_id", staffId).order("start_date", { ascending: false }),
      ]);
      if (profile) {
        setCostForm({
          hourly_rate: Number(profile.hourly_rate),
          super_rate: Number(profile.super_rate),
          workers_comp_rate: Number(profile.workers_comp_rate),
          leave_loading_rate: Number(profile.leave_loading_rate),
          annual_fixed_oncosts: Number(profile.annual_fixed_oncosts),
          target_hours_per_week: Number(profile.target_hours_per_week),
        });
      } else {
        setCostForm(emptyCostForm);
      }
      setLeaveEntries((leave as any) ?? []);
      setLoading(false);
    }
    load();
  }, [open, staffId]);

  function setField(field: keyof StaffCostInputs, value: string) {
    setCostForm((p) => ({ ...p, [field]: value === "" ? 0 : parseFloat(value) }));
  }

  async function saveCostProfile() {
    setSaving(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase.from("staff_cost_profiles").upsert({
      staff_id: staffId,
      ...costForm,
      updated_at: new Date().toISOString(),
      updated_by: user?.id ?? null,
    });
    setSaving(false);
    if (error) {
      toast.error("Failed to save cost profile");
      return;
    }
    toast.success("Cost profile saved");
  }

  async function addLeave() {
    if (!leaveForm.start_date || !leaveForm.end_date || !leaveForm.hours) {
      toast.error("Start date, end date and hours are required");
      return;
    }
    setAddingLeave(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("staff_leave")
      .insert({
        staff_id: staffId,
        leave_type: leaveForm.leave_type,
        start_date: leaveForm.start_date,
        end_date: leaveForm.end_date,
        hours: parseFloat(leaveForm.hours),
        notes: leaveForm.notes || null,
        created_by: user?.id ?? null,
      })
      .select()
      .single();
    setAddingLeave(false);
    if (error || !data) {
      toast.error("Failed to log leave");
      return;
    }
    setLeaveEntries((prev) => [data as LeaveEntry, ...prev]);
    setLeaveForm(emptyLeaveForm);
    toast.success("Leave logged");
  }

  async function deleteLeave(id: string) {
    const { error } = await supabase.from("staff_leave").delete().eq("id", id);
    if (error) {
      toast.error("Failed to delete leave entry");
      return;
    }
    setLeaveEntries((prev) => prev.filter((l) => l.id !== id));
  }

  const { annualLoadedCost, loadedHourlyRate } = computeLoadedCost(costForm);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{staffName} — Cost &amp; Leave</DialogTitle>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-slate-400 py-8 text-center">Loading...</p>
        ) : (
          <Tabs defaultValue="cost">
            <TabsList>
              <TabsTrigger value="cost">Cost Profile</TabsTrigger>
              <TabsTrigger value="leave">Leave Log</TabsTrigger>
            </TabsList>

            <TabsContent value="cost" className="space-y-4 pt-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Hourly Rate ($)</Label>
                  <Input type="number" step="0.01" value={costForm.hourly_rate} onChange={(e) => setField("hourly_rate", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Target Hours/Week</Label>
                  <Input type="number" step="0.5" value={costForm.target_hours_per_week} onChange={(e) => setField("target_hours_per_week", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Super (%)</Label>
                  <Input type="number" step="0.1" value={costForm.super_rate} onChange={(e) => setField("super_rate", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Workers Comp (%)</Label>
                  <Input type="number" step="0.1" value={costForm.workers_comp_rate} onChange={(e) => setField("workers_comp_rate", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Leave Loading (%)</Label>
                  <Input type="number" step="0.1" value={costForm.leave_loading_rate} onChange={(e) => setField("leave_loading_rate", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Annual Fixed On-costs ($)</Label>
                  <Input type="number" step="1" value={costForm.annual_fixed_oncosts} onChange={(e) => setField("annual_fixed_oncosts", e.target.value)} />
                  <p className="text-xs text-slate-400">Vehicle, phone, tools/PPE, training — per year</p>
                </div>
              </div>

              <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-500">Loaded Hourly Rate</p>
                  <p className="text-lg font-bold text-slate-900">${loadedHourlyRate.toFixed(2)}/hr</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-slate-500">Annual Loaded Cost</p>
                  <p className="text-lg font-bold text-slate-900">${annualLoadedCost.toLocaleString("en-AU", { maximumFractionDigits: 0 })}</p>
                </div>
              </div>

              <div className="flex justify-end">
                <Button onClick={saveCostProfile} disabled={saving}>{saving ? "Saving..." : "Save Cost Profile"}</Button>
              </div>
            </TabsContent>

            <TabsContent value="leave" className="space-y-4 pt-3">
              <div className="grid grid-cols-2 gap-3 items-end">
                <div className="space-y-1.5">
                  <Label>Type</Label>
                  <Select value={leaveForm.leave_type} onValueChange={(v) => setLeaveForm((p) => ({ ...p, leave_type: v ?? "sick" }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(LEAVE_TYPE_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Hours</Label>
                  <Input type="number" step="0.5" value={leaveForm.hours} onChange={(e) => setLeaveForm((p) => ({ ...p, hours: e.target.value }))} placeholder="e.g. 7.6" />
                </div>
                <div className="space-y-1.5">
                  <Label>Start Date</Label>
                  <Input type="date" value={leaveForm.start_date} onChange={(e) => setLeaveForm((p) => ({ ...p, start_date: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>End Date</Label>
                  <Input type="date" value={leaveForm.end_date} onChange={(e) => setLeaveForm((p) => ({ ...p, end_date: e.target.value }))} />
                </div>
                <div className="space-y-1.5 col-span-2">
                  <Label>Notes</Label>
                  <Input value={leaveForm.notes} onChange={(e) => setLeaveForm((p) => ({ ...p, notes: e.target.value }))} placeholder="Optional" />
                </div>
              </div>
              <Button onClick={addLeave} disabled={addingLeave} size="sm">{addingLeave ? "Logging..." : "Log Leave"}</Button>

              <div className="space-y-2 pt-2 border-t">
                {leaveEntries.length === 0 ? (
                  <p className="text-sm text-slate-400 text-center py-4">No leave logged yet</p>
                ) : (
                  leaveEntries.map((l) => (
                    <div key={l.id} className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2 text-sm">
                      <div>
                        <span className="font-medium text-slate-700">{LEAVE_TYPE_LABELS[l.leave_type] ?? l.leave_type}</span>
                        <span className="text-slate-400 ml-2 text-xs">
                          {formatDate(l.start_date)} – {formatDate(l.end_date)}
                        </span>
                        <span className="ml-2 font-semibold text-slate-800">{Number(l.hours).toFixed(1)}h</span>
                        {l.notes && <p className="text-xs text-slate-400 mt-0.5">{l.notes}</p>}
                      </div>
                      <button onClick={() => deleteLeave(l.id)} className="text-slate-300 hover:text-red-500">
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
