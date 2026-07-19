"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type RateOverride = "normal" | "time_and_half" | "double_time";

interface TimeEntry {
  id: string;
  staff_id: string;
  clock_in: string;
  clock_out: string | null;
  hours: number | null;
  auto_clocked: boolean;
  entry_type?: "work" | "travel";
  cost_center_id: string | null;
  edited_at?: string | null;
  rate_override?: RateOverride | null;
  profiles: { full_name: string };
}

interface CostCenterOption {
  id: string;
  name: string;
  code: string | null;
  po_number?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "edit" | "add";
  jobId: string;
  currentUserId: string;
  entry?: TimeEntry;
  costCenters: CostCenterOption[];
  // Gates the manual billing-rate override control below -- only Admins
  // can set it (time_entries.rate_override is DB-enforced Admin-only via a
  // trigger, see migration 0025, so this is just keeping the UI in sync
  // with what would actually be allowed to save).
  isAdmin?: boolean;
  onSaved: (entry: TimeEntry) => void;
  onDeleted?: (id: string) => void;
}

// Sentinel for the Select control -- Radix/shadcn's SelectItem can't take
// value="", and "auto" reads better than an empty option anyway (mirrors
// the UNASSIGNED_VALUE pattern used for the cost-center picker).
const AUTO_RATE_VALUE = "auto";

// datetime-local inputs work in local time with no timezone suffix, so we
// need to format/parse against local time components rather than ISO/UTC.
function toLocalInputValue(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TimeEntryEditDialog({ open, onOpenChange, mode, jobId, currentUserId, entry, costCenters, isAdmin, onSaved, onDeleted }: Props) {
  const supabase = createClient();
  const [entryType, setEntryType] = useState<"work" | "travel">("work");
  const [clockIn, setClockIn] = useState("");
  const [clockOut, setClockOut] = useState("");
  const [stillOpen, setStillOpen] = useState(false);
  const [costCenterId, setCostCenterId] = useState<string>("none");
  const [rateOverride, setRateOverride] = useState<string>(AUTO_RATE_VALUE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (mode === "edit" && entry) {
      setEntryType(entry.entry_type === "travel" ? "travel" : "work");
      setClockIn(toLocalInputValue(entry.clock_in));
      setClockOut(entry.clock_out ? toLocalInputValue(entry.clock_out) : "");
      setStillOpen(!entry.clock_out);
      setCostCenterId(entry.cost_center_id ?? "none");
      setRateOverride(entry.rate_override ?? AUTO_RATE_VALUE);
    } else {
      const now = toLocalInputValue(new Date().toISOString());
      setEntryType("work");
      setClockIn(now);
      setClockOut(now);
      setStillOpen(false);
      setCostCenterId("none");
      setRateOverride(AUTO_RATE_VALUE);
    }
  }, [open, mode, entry]);

  const clockInDate = clockIn ? new Date(clockIn) : null;
  const clockOutDate = !stillOpen && clockOut ? new Date(clockOut) : null;
  const invalid = !clockInDate || (clockOutDate ? clockOutDate.getTime() <= clockInDate.getTime() : false);
  const hoursPreview =
    clockInDate && clockOutDate && !invalid
      ? Math.round(((clockOutDate.getTime() - clockInDate.getTime()) / 3600000) * 100) / 100
      : null;

  async function handleSave() {
    if (invalid || !clockInDate) return;
    setSaving(true);
    const hours = clockOutDate
      ? Math.round(((clockOutDate.getTime() - clockInDate.getTime()) / 3600000) * 100) / 100
      : null;
    const nowIso = new Date().toISOString();
    const payload = {
      clock_in: clockInDate.toISOString(),
      clock_out: clockOutDate ? clockOutDate.toISOString() : null,
      hours,
      cost_center_id: entryType === "travel" ? null : costCenterId === "none" ? null : costCenterId,
      edited_by: currentUserId,
      edited_at: nowIso,
      // Non-admins never send this field at all (rather than sending null),
      // so the request can't clobber whatever an Admin already set -- the
      // DB trigger from migration 0025 would revert it anyway, but there's
      // no reason to rely on that as the only line of defence.
      ...(isAdmin ? { rate_override: rateOverride === AUTO_RATE_VALUE ? null : rateOverride } : {}),
    };

    if (mode === "add") {
      const { data, error } = await supabase
        .from("time_entries")
        .insert({ job_id: jobId, staff_id: currentUserId, entry_type: entryType, auto_clocked: false, ...payload })
        // time_entries has two FKs to profiles (staff_id, edited_by) — must
        // name the exact FK or PostgREST rejects the query as ambiguous.
        .select("*, profiles!time_entries_staff_id_fkey(full_name)")
        .single();
      setSaving(false);
      if (error || !data) {
        toast.error("Failed to add entry");
        return;
      }
      toast.success("Manual entry added");
      onSaved(data as TimeEntry);
      onOpenChange(false);
      // Fire-and-forget: regenerates the job's auto labour line item from
      // this entry (see app/api/time-entries/[id]/sync-billing/route.ts).
      fetch(`/api/time-entries/${data.id}/sync-billing`, { method: "POST" }).catch(() => {});
    } else if (entry) {
      const { data, error } = await supabase
        .from("time_entries")
        .update(payload)
        .eq("id", entry.id)
        .select("*, profiles!time_entries_staff_id_fkey(full_name)")
        .single();
      setSaving(false);
      if (error || !data) {
        toast.error("Failed to update entry");
        return;
      }
      toast.success("Entry updated");
      onSaved(data as TimeEntry);
      onOpenChange(false);
      fetch(`/api/time-entries/${data.id}/sync-billing`, { method: "POST" }).catch(() => {});
    }
  }

  async function handleDelete() {
    if (!entry || !onDeleted) return;
    setSaving(true);
    const { error } = await supabase.from("time_entries").delete().eq("id", entry.id);
    setSaving(false);
    if (error) {
      toast.error("Failed to delete entry");
      return;
    }
    toast.success("Entry deleted");
    onDeleted(entry.id);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Add Manual Time Entry" : "Edit Time Entry"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-xs text-slate-400">
            Use this when auto clock-in/out didn&apos;t fire correctly — set the real start/end time.
          </p>

          {mode === "add" && (
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={entryType} onValueChange={(v) => setEntryType((v as "work" | "travel") ?? "work")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="work">Work</SelectItem>
                  <SelectItem value="travel">Travel</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Start</Label>
              <Input type="datetime-local" value={clockIn} onChange={(e) => setClockIn(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>End</Label>
              <Input
                type="datetime-local"
                value={clockOut}
                disabled={stillOpen}
                onChange={(e) => setClockOut(e.target.value)}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-500">
            <input type="checkbox" checked={stillOpen} onChange={(e) => setStillOpen(e.target.checked)} />
            Still clocked in (no end time yet)
          </label>

          {invalid && <p className="text-xs text-red-500">End time must be after start time</p>}
          {hoursPreview != null && <p className="text-lg font-semibold text-slate-800">{hoursPreview.toFixed(2)}h</p>}

          {entryType !== "travel" && costCenters.length > 0 && (
            <div className="space-y-1.5">
              <Label>Stage</Label>
              <Select value={costCenterId} onValueChange={(v) => setCostCenterId(v ?? "none")}>
                <SelectTrigger><SelectValue placeholder="Assign to stage..." /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {costCenters.map((cc) => (
                    <SelectItem key={cc.id} value={cc.id}>
                      {cc.name}{cc.po_number ? ` (PO #${cc.po_number})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {entryType !== "travel" && isAdmin && (
            <div className="space-y-1.5">
              <Label>Billing Rate</Label>
              <Select value={rateOverride} onValueChange={(v) => setRateOverride(v ?? AUTO_RATE_VALUE)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_RATE_VALUE}>Auto-detected (normal/overtime by day &amp; time)</SelectItem>
                  <SelectItem value="normal">Normal rate</SelectItem>
                  <SelectItem value="time_and_half">Time and a half</SelectItem>
                  <SelectItem value="double_time">Double time</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-400">
                Overrides the automatic weekday/weekend detection -- e.g. use &quot;Normal rate&quot; for a job scheduled on a weekend for convenience rather than a genuine after-hours call-out.
              </p>
            </div>
          )}

          <div className="flex justify-between gap-2">
            {mode === "edit" && onDeleted ? (
              <Button variant="outline" onClick={handleDelete} disabled={saving} className="border-red-200 text-red-600 hover:bg-red-50">
                Delete
              </Button>
            ) : <div />}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving || invalid}>{saving ? "Saving..." : "Save"}</Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
