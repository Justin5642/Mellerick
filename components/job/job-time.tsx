"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { plausibleClockedHours } from "@/lib/time-entry-hours";
import { TIME_ENTRY_SELECT_WITH_STAFF } from "@/lib/time-entry-columns";
import { canEditTimeEntry } from "@/lib/time-entry-access";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Clock, LogIn, LogOut, Smartphone, Car, Pencil, Plus } from "lucide-react";
import { TimeEntryEditDialog } from "@/components/job/time-entry-edit-dialog";
import { BUSINESS_TIME_ZONE } from "@/lib/date";
import { clockPlace } from "@/lib/clock-location";

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
  rate_override?: "normal" | "time_and_half" | "double_time" | null;
  profiles: { full_name: string };
  clock_in_lat?: number | null;
  clock_in_lng?: number | null;
  clock_in_accuracy?: number | null;
  clock_out_lat?: number | null;
  clock_out_lng?: number | null;
  clock_out_accuracy?: number | null;
}

interface CostCenterOption {
  id: string;
  name: string;
  code: string | null;
  po_number?: string;
}

interface StaffOption {
  id: string;
  full_name: string;
}

interface Props {
  jobId: string;
  currentUserId: string;
  timeEntries: TimeEntry[];
  /** The job site's pin, to show how far from it each clock-on/off was (0092). */
  site?: { site_lat: number | null; site_lng: number | null } | null;
  costCenters: CostCenterOption[];
  isAdmin?: boolean;
  // Active staff for the admin "log on behalf of" picker in the edit dialog.
  staff?: StaffOption[];
  onUpdate: (entries: TimeEntry[]) => void;
  // The stage picked when this job was scheduled — new clock-ins default to it
  // instead of landing unassigned.
  scheduledCostCenterId?: string | null;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", timeZone: BUSINESS_TIME_ZONE });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: BUSINESS_TIME_ZONE });
}

// Fire-and-forget: regenerates the job's auto-generated labour line item
// (see app/api/time-entries/[id]/sync-billing/route.ts) right after any
// write to a time_entries row -- same "insert/update then fetch(/api/...)"
// pattern already used for a job's Google Calendar sync. The web session
// cookie rides along automatically since this is a same-origin fetch.
function syncBilling(entryId: string) {
  fetch(`/api/time-entries/${entryId}/sync-billing`, { method: "POST" }).catch(() => {});
}

export function JobTime({ jobId, currentUserId, timeEntries: initial, site, costCenters, isAdmin, staff, onUpdate, scheduledCostCenterId }: Props) {
  const supabase = createClient();
  const [entries, setEntries] = useState<TimeEntry[]>(initial);
  const [loading, setLoading] = useState(false);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [editDialog, setEditDialog] = useState<{ mode: "edit" | "add"; entry?: TimeEntry } | null>(null);

  // Single source of truth for entries lives in local state; mirror every change up
  // to the parent so the PO tab's per-stage actuals stay in sync without a
  // full page reload.
  useEffect(() => {
    onUpdate(entries);
  }, [entries]);

  async function assignCostCenter(entryId: string, costCenterId: string) {
    // Same rule as the disabled picker below — a second check so a stale
    // render cannot slip a write through for someone else's entry.
    const target = entries.find((e) => e.id === entryId);
    if (!target || !canEditTimeEntry(target, currentUserId, isAdmin)) return;
    setAssigningId(entryId);
    const { data, error } = await supabase
      .from("time_entries")
      .update({ cost_center_id: costCenterId === "none" ? null : costCenterId })
      .eq("id", entryId)
      // time_entries has two FKs to profiles (staff_id, edited_by) — must
      // name the exact FK or PostgREST rejects the query as ambiguous.
      .select(TIME_ENTRY_SELECT_WITH_STAFF)
      .single();
    setAssigningId(null);
    if (error || !data) {
      toast.error("Failed to assign stage");
      return;
    }
    setEntries((prev) => prev.map((e) => (e.id === entryId ? (data as unknown as TimeEntry) : e)));
  }

  const myOpenEntry = entries.find(e => e.staff_id === currentUserId && e.entry_type !== "travel" && !e.clock_out);
  const workEntries = entries.filter(e => e.entry_type !== "travel");
  const travelEntries = entries.filter(e => e.entry_type === "travel");
  const totalHours = workEntries.reduce((sum, e) => sum + (e.hours ? Number(e.hours) : 0), 0);
  const totalTravelHours = travelEntries.reduce((sum, e) => sum + (e.hours ? Number(e.hours) : 0), 0);

  // No automatic clocking here. The website used to run its own geofence
  // while this tab was open, and its first reading away from site closed the
  // viewer's open entry — a tech clocked in on the phone who opened the job
  // in the office was clocked out (Justin approved removing it, 31 Oct 2026).
  // Automatic clock-in/out belongs to the phone app alone.

  async function clockIn() {
    if (myOpenEntry || loading) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("time_entries")
      .insert({ job_id: jobId, staff_id: currentUserId, clock_in: new Date().toISOString(), auto_clocked: false, cost_center_id: scheduledCostCenterId ?? null })
      .select(TIME_ENTRY_SELECT_WITH_STAFF)
      .single();
    setLoading(false);
    // This exact spot caused the 4 Aug outage: the error was discarded, so a
    // refused RETURNING clause rolled the INSERT back while the UI still said
    // "Clocked in". Unpaid hours, no error, nothing to notice.
    if (error || !data) {
      toast.error("Clock in failed — your time was NOT recorded. Try again.");
      return;
    }
    setEntries(e => [data as unknown as TimeEntry, ...e]);
    toast.success("Clocked in");
    syncBilling(data.id);
  }

  async function clockOut() {
    if (!myOpenEntry || loading) return;
    setLoading(true);
    const clockOutTime = new Date().toISOString();
    const hours = plausibleClockedHours(myOpenEntry.clock_in, clockOutTime);
    const { data, error } = await supabase
      .from("time_entries")
      .update({ clock_out: clockOutTime, hours })
      .eq("id", myOpenEntry.id)
      .select(TIME_ENTRY_SELECT_WITH_STAFF)
      .single();
    setLoading(false);
    // A discarded failure leaves the entry open and still running.
    if (error || !data) {
      toast.error("Clock out failed — you are still clocked in. Try again.");
      return;
    }
    setEntries(e => e.map(en => en.id === myOpenEntry.id ? data as unknown as TimeEntry : en));
    toast.success("Clocked out");
    syncBilling(data.id);
  }

  return (
    <div className="p-6 space-y-5">
      <p className="text-xs text-slate-400 flex items-center gap-1.5">
        <Smartphone className="w-3 h-3" />Automatic clock-in/out happens in the phone app. Here it&apos;s manual.
      </p>

      {/* Manual clock in/out */}
      <div className="flex items-center gap-3">
        {!myOpenEntry ? (
          <Button onClick={clockIn} disabled={loading} className="gap-2">
            <LogIn className="w-4 h-4" />Clock In
          </Button>
        ) : (
          <>
            <Button onClick={clockOut} disabled={loading} variant="outline" className="gap-2 border-red-200 text-red-600 hover:bg-red-50">
              <LogOut className="w-4 h-4" />Clock Out
            </Button>
            <span className="flex items-center gap-1.5 text-sm text-green-600 font-medium">
              <Clock className="w-4 h-4" />Since {formatTime(myOpenEntry.clock_in)}
            </span>
          </>
        )}
      </div>

      {/* Time log */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold text-slate-700">Time Log</h3>
          <div className="flex items-center gap-3">
            {entries.length > 0 && (
              <span className="text-sm font-bold text-slate-900">
                {totalHours.toFixed(1)}h total
                {totalTravelHours > 0 && <span className="text-slate-400 font-normal"> · {totalTravelHours.toFixed(1)}h travel</span>}
              </span>
            )}
            <Button variant="outline" size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setEditDialog({ mode: "add" })}>
              <Plus className="w-3.5 h-3.5" />Add manual entry
            </Button>
          </div>
        </div>
        <p className="text-xs text-slate-400 mb-3">
          Use this if auto clock-in/out didn&apos;t fire correctly — click an entry below to correct it.
        </p>
        {entries.length > 0 && (
          <div className="space-y-2">
            {entries.map(entry => {
              const isTravel = entry.entry_type === "travel";
              // Admins can open any entry (e.g. to re-attribute time logged by
              // the wrong person, or correct a tech's hours); everyone else
              // can only edit their own. Gates the stage picker too.
              const canEdit = canEditTimeEntry(entry, currentUserId, isAdmin);
              return (
                <div key={entry.id} className={`py-2.5 px-3 rounded-lg text-sm space-y-1.5 ${isTravel ? "bg-blue-50/60" : "bg-slate-50"}`}>
                  <button
                    type="button"
                    className={`flex items-center justify-between w-full text-left ${canEdit ? "cursor-pointer" : "cursor-default"}`}
                    onClick={() => canEdit && setEditDialog({ mode: "edit", entry })}
                    disabled={!canEdit}
                  >
                    <div className="flex items-center gap-1.5">
                      {isTravel && <Car className="w-3.5 h-3.5 text-blue-500" />}
                      <span className="font-medium text-slate-800">{entry.profiles?.full_name}</span>
                      <span className="text-slate-400 text-xs ml-1">{formatDate(entry.clock_in)}</span>
                      {isTravel ? (
                        <span className="text-xs text-blue-500 ml-1.5 bg-blue-100 px-1.5 py-0.5 rounded">travel</span>
                      ) : entry.auto_clocked && (
                        <span className="text-xs text-blue-500 ml-1.5 bg-blue-50 px-1.5 py-0.5 rounded">auto</span>
                      )}
                      {entry.edited_at && (
                        <span className="text-xs text-slate-500 ml-1.5 bg-slate-100 px-1.5 py-0.5 rounded">edited</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-right text-slate-600">
                      <span>
                        {formatTime(entry.clock_in)} → {entry.clock_out ? formatTime(entry.clock_out) : <span className="text-green-600 font-medium">now</span>}
                        {entry.hours != null && (
                          <span className="ml-2 font-semibold text-slate-800">{Number(entry.hours).toFixed(1)}h</span>
                        )}
                      </span>
                      {canEdit && <Pencil className="w-3 h-3 text-slate-400" />}
                    </div>
                  </button>
                  {!isTravel && (() => {
                    const pin = site ? { lat: site.site_lat, lng: site.site_lng } : null;
                    const on = clockPlace({ lat: entry.clock_in_lat, lng: entry.clock_in_lng, accuracy: entry.clock_in_accuracy }, pin);
                    const off = clockPlace({ lat: entry.clock_out_lat, lng: entry.clock_out_lng, accuracy: entry.clock_out_accuracy }, pin);
                    if (!on && !off) return null;
                    return (
                      <p className="text-xs text-slate-500 flex flex-wrap gap-x-3">
                        {on && <span className={on.outside ? "text-amber-700 font-medium" : ""}>{on.outside ? "⚠ " : ""}In: {on.label}</span>}
                        {off && <span className={off.outside ? "text-amber-700 font-medium" : ""}>{off.outside ? "⚠ " : ""}Out: {off.label}</span>}
                      </p>
                    );
                  })()}
                  {!isTravel && costCenters.length > 0 && (
                    <Select
                      value={entry.cost_center_id ?? "none"}
                      onValueChange={(v) => assignCostCenter(entry.id, v ?? "none")}
                      disabled={!canEdit || assigningId === entry.id}
                    >
                      <SelectTrigger className="h-7 text-xs w-56 bg-white"><SelectValue placeholder="Assign to stage..." /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Unassigned</SelectItem>
                        {costCenters.map((cc) => (
                          <SelectItem key={cc.id} value={cc.id}>
                            {cc.name}{cc.po_number ? ` (PO #${cc.po_number})` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {entries.length === 0 && (
          <p className="text-sm text-slate-400 text-center py-8">No time logged yet</p>
        )}
      </div>

      <TimeEntryEditDialog
        open={!!editDialog}
        onOpenChange={(o) => !o && setEditDialog(null)}
        mode={editDialog?.mode ?? "add"}
        jobId={jobId}
        currentUserId={currentUserId}
        entry={editDialog?.entry}
        costCenters={costCenters}
        isAdmin={isAdmin}
        staff={staff}
        onSaved={(saved) => {
          setEntries((prev) => {
            const exists = prev.some((e) => e.id === saved.id);
            return exists ? prev.map((e) => (e.id === saved.id ? saved : e)) : [saved, ...prev];
          });
        }}
        onDeleted={(id) => setEntries((prev) => prev.filter((e) => e.id !== id))}
      />
    </div>
  );
}
