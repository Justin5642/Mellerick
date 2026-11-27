"use client";

import { LinkToMistakeButton } from "@/components/mistakes/link-to-mistake-button";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { plausibleClockedHours } from "@/lib/time-entry-hours";
import { TIME_ENTRY_SELECT_WITH_STAFF } from "@/lib/time-entry-columns";
import { canEditTimeEntry } from "@/lib/time-entry-access";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Clock, LogIn, LogOut, Smartphone, Car, Pencil, Plus, Repeat } from "lucide-react";
import { TimeEntryEditDialog } from "@/components/job/time-entry-edit-dialog";
import { BUSINESS_TIME_ZONE } from "@/lib/date";
import { clockPlace } from "@/lib/clock-location";
import {
  isMissingVariationColumn,
  isOpenVariation,
  openVariations,
  planClockSwitch,
  variationLabel,
  variationName,
  variationTimeRefusal,
  type VariationRef,
} from "@/lib/variation-time";
import { choiceVariationId, clockOnChoices, clockOnRow, showVariationChoice, STAGE_CHOICE, switchedText } from "@/lib/web-clock-on";

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
  /** The variation this time is for (0120 (draft)); absent on a database without it. */
  variation_id?: string | null;
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
  site?: { site_lat: number | null; site_lng: number | null; geofence_radius_m?: number | null } | null;
  costCenters: CostCenterOption[];
  isAdmin?: boolean;
  // Active staff for the admin "log on behalf of" picker in the edit dialog.
  staff?: StaffOption[];
  onUpdate: (entries: TimeEntry[]) => void;
  // The stage picked when this job was scheduled — new clock-ins default to it
  // instead of landing unassigned.
  scheduledCostCenterId?: string | null;
  /** Office/admin: the "part of a mistake?" tick on each work entry (rework time, 0119 (a draft, not applied yet)). */
  canLinkMistakes?: boolean;
  /** Office/admin: may move anyone's entry on or off a variation (RLS 0030). */
  isOffice?: boolean;
  /**
   * The job's variations (money-free fields only are read here). Time can be
   * moved onto one that isn't rejected (0120 (draft)); the picker hides when the job
   * has none or the database has no variation_id yet.
   */
  variations?: VariationRef[];
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

export function JobTime({ jobId, currentUserId, timeEntries: initial, site, costCenters, isAdmin, staff, onUpdate, scheduledCostCenterId, canLinkMistakes, isOffice, variations = [] }: Props) {
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
    setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, ...(data as unknown as TimeEntry) } : e)));
  }

  // Time against a variation (0120 (draft)): the variation_id column is known to the
  // database once any entry came back with the key. Before 0120 (draft) the page read
  // falls back to the plain list and no entry has it, so the picker hides.
  const variationsReady = entries.some((e) => "variation_id" in e);
  const variationById = new Map(variations.map((v) => [v.id, v]));
  const [movingId, setMovingId] = useState<string | null>(null);

  async function setVariation(entryId: string, variationId: string | null) {
    const target = entries.find((e) => e.id === entryId);
    // The technician on their own entries; office/admin on anyone's (RLS 0030).
    if (!target || !(canEditTimeEntry(target, currentUserId, isAdmin) || isOffice)) return;
    setMovingId(entryId);
    const { error } = await supabase.from("time_entries").update({ variation_id: variationId }).eq("id", entryId);
    setMovingId(null);
    if (error) {
      toast.error(
        isMissingVariationColumn(error)
          ? "Time against variations isn't switched on yet."
          : variationTimeRefusal(error.message) ?? "Couldn't move that time — try again."
      );
      return;
    }
    setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, variation_id: variationId } : e)));
    toast.success(variationId ? "Moved onto the variation" : "Moved back to the stage");
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

  // Clock In / Switch can pick a variation (27 Nov 2026) — the phone's
  // clock-on sheet, on the web: the stage (the job's scheduled cost centre, as
  // before) or one of the job's open variations (lib/web-clock-on.ts).
  const [columnMissing, setColumnMissing] = useState(false);
  const [clockOnChoice, setClockOnChoice] = useState<string>(STAGE_CHOICE);
  const [switchChoice, setSwitchChoice] = useState<string>("");
  const offerVariations = showVariationChoice({
    openCount: openVariations(variations).length,
    entryCount: entries.length,
    variationsReady,
    columnMissing,
  });

  /** Insert a clock-on as the user; a database without variation_id retries as stage time. */
  async function insertClockOn(atIso: string, costCenterId: string | null, variationId: string | null) {
    const first = await supabase
      .from("time_entries")
      .insert(clockOnRow({ jobId, staffId: currentUserId, atIso, costCenterId, variationId }))
      .select(TIME_ENTRY_SELECT_WITH_STAFF)
      .single();
    if (first.error && variationId && isMissingVariationColumn(first.error)) {
      setColumnMissing(true);
      const retry = await supabase
        .from("time_entries")
        .insert(clockOnRow({ jobId, staffId: currentUserId, atIso, costCenterId, variationId: null }))
        .select(TIME_ENTRY_SELECT_WITH_STAFF)
        .single();
      if (!retry.error && retry.data) toast.message("Time against variations isn't switched on yet — clocked on to the stage.");
      return { ...retry, variationId: null };
    }
    return { ...first, variationId };
  }

  /** The row as the tab keeps it: the read-back list has no variation_id, so carry the one written. */
  function asEntry(data: unknown, variationId: string | null): TimeEntry {
    const row = data as TimeEntry;
    return variationsReady || variationId ? { ...row, variation_id: variationId } : row;
  }

  async function clockIn() {
    if (myOpenEntry || loading) return;
    setLoading(true);
    const variationId = offerVariations ? choiceVariationId(clockOnChoice) : null;
    const { data, error, variationId: written } = await insertClockOn(new Date().toISOString(), scheduledCostCenterId ?? null, variationId);
    setLoading(false);
    // This exact spot caused the 4 Aug outage: the error was discarded, so a
    // refused RETURNING clause rolled the INSERT back while the UI still said
    // "Clocked in". Unpaid hours, no error, nothing to notice.
    if (error || !data) {
      const refusal = variationTimeRefusal(error?.message);
      toast.error(refusal ? `${refusal} Your time was NOT recorded.` : "Clock in failed — your time was NOT recorded. Try again.");
      return;
    }
    setEntries(e => [asEntry(data, written), ...e]);
    setClockOnChoice(STAGE_CHOICE);
    toast.success(written ? "Clocked in — on the variation" : "Clocked in");
    syncBilling(data.id);
  }

  // "Switch to a variation / back to the stage" while clocked on: the open
  // entry ends and the new one starts at the same instant (planClockSwitch).
  // Clock-off first — 0090 allows one open work entry per person per job.
  async function switchClock() {
    if (!myOpenEntry || loading || !switchChoice) return;
    const variationId = choiceVariationId(switchChoice);
    const plan = planClockSwitch(myOpenEntry, { costCenterId: myOpenEntry.cost_center_id, variationId }, new Date().toISOString());
    if (!plan) return;
    setLoading(true);
    const hours = plausibleClockedHours(myOpenEntry.clock_in, plan.clockOutIso);
    const off = await supabase
      .from("time_entries")
      .update({ clock_out: plan.clockOutIso, hours })
      .eq("id", myOpenEntry.id)
      .select(TIME_ENTRY_SELECT_WITH_STAFF)
      .single();
    if (off.error || !off.data) {
      setLoading(false);
      toast.error("Couldn't switch — you are still clocked in as before. Try again.");
      return;
    }
    const closedId = myOpenEntry.id;
    setEntries(e => e.map(en => en.id === closedId ? { ...en, ...(off.data as unknown as TimeEntry) } : en));
    syncBilling(closedId);
    const on = await insertClockOn(plan.clockInIso, myOpenEntry.cost_center_id, variationId);
    setLoading(false);
    setSwitchChoice("");
    if (on.error || !on.data) {
      const refusal = variationTimeRefusal(on.error?.message);
      toast.error(`${refusal ? `${refusal} ` : ""}You were clocked off but NOT clocked back on — press Clock In.`);
      return;
    }
    setEntries(e => [asEntry(on.data, on.variationId), ...e]);
    toast.success(switchedText(on.variationId));
    syncBilling(on.data.id);
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
    setEntries(e => e.map(en => en.id === myOpenEntry.id ? { ...en, ...(data as unknown as TimeEntry) } : en));
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
          <>
            {offerVariations && (
              <Select value={clockOnChoice} onValueChange={(v) => setClockOnChoice(v ?? STAGE_CHOICE)} disabled={loading}>
                <SelectTrigger className={`h-9 text-sm w-64 ${clockOnChoice !== STAGE_CHOICE ? "bg-amber-50 border-amber-300" : "bg-white"}`} aria-label="What are you clocking on to?">
                  <SelectValue placeholder="Stage work" />
                </SelectTrigger>
                <SelectContent>
                  {clockOnChoices(variations).map((c) => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button onClick={clockIn} disabled={loading} className="gap-2">
              <LogIn className="w-4 h-4" />Clock In
            </Button>
          </>
        ) : (
          <>
            <Button onClick={clockOut} disabled={loading} variant="outline" className="gap-2 border-red-200 text-red-600 hover:bg-red-50">
              <LogOut className="w-4 h-4" />Clock Out
            </Button>
            <span className="flex items-center gap-1.5 text-sm text-green-600 font-medium">
              <Clock className="w-4 h-4" />Since {formatTime(myOpenEntry.clock_in)}
              {myOpenEntry.variation_id && (
                <span className="text-amber-700">
                  {" "}· on {variationById.get(myOpenEntry.variation_id) ? variationName(variationById.get(myOpenEntry.variation_id)!) : "a variation"}
                </span>
              )}
            </span>
          </>
        )}
      </div>
      {myOpenEntry && myOpenEntry.entry_type !== "travel" && !columnMissing && (variationsReady || entries.length <= 1) && (() => {
        const choices = clockOnChoices(variations, myOpenEntry.variation_id ?? null);
        if (choices.length === 0) return null;
        return (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={switchChoice} onValueChange={(v) => setSwitchChoice(v ?? "")} disabled={loading}>
              <SelectTrigger className="h-8 text-xs w-64 bg-white" aria-label="Switch to">
                <SelectValue placeholder={myOpenEntry.variation_id ? "Switch variation / back to the stage…" : "Switch to a variation (e.g. hit rock)…"} />
              </SelectTrigger>
              <SelectContent>
                {choices.map((c) => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="gap-1.5 h-8" onClick={switchClock} disabled={loading || !switchChoice}>
              <Repeat className="w-3.5 h-3.5" />Switch
            </Button>
            <span className="text-xs text-slate-400">Clocks off and on again at the same minute.</span>
          </div>
        );
      })()}

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
                    const pin = site ? { lat: site.site_lat, lng: site.site_lng, fenceM: site.geofence_radius_m } : null;
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
                  {!isTravel && variationsReady && (variations.length > 0 || entry.variation_id) && (() => {
                    const current = entry.variation_id ? variationById.get(entry.variation_id) : undefined;
                    const canMove = canEditTimeEntry(entry, currentUserId, isAdmin) || !!isOffice;
                    const options = variations.filter((v) => isOpenVariation(v) || v.id === entry.variation_id);
                    return (
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          value={entry.variation_id ?? "none"}
                          onValueChange={(v) => setVariation(entry.id, !v || v === "none" ? null : v)}
                          disabled={!canMove || movingId === entry.id}
                        >
                          <SelectTrigger className={`h-7 text-xs w-56 ${entry.variation_id ? "bg-amber-50 border-amber-300" : "bg-white"}`}>
                            <SelectValue placeholder="Stage work" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">Stage work (not a variation)</SelectItem>
                            {options.map((v) => (
                              <SelectItem key={v.id} value={v.id}>{variationLabel(v)}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {entry.variation_id && (
                          <span className="text-xs text-amber-700">
                            Variation time{current ? ` — ${variationName(current)}` : ""} · not counted in the stage&apos;s allowed hours
                          </span>
                        )}
                      </div>
                    );
                  })()}
                  {!isTravel && canLinkMistakes && entry.clock_out && (
                    <div className="flex items-center gap-1 text-xs text-slate-400">
                      <LinkToMistakeButton jobId={jobId} source="time_entry" sourceId={entry.id} entryHours={entry.hours == null ? null : Number(entry.hours)} />
                      Rework? Mark as part of a mistake
                    </div>
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
            // Keep the entry's variation (the dialog reads back without it).
            return exists ? prev.map((e) => (e.id === saved.id ? { ...e, ...saved } : e)) : [saved, ...prev];
          });
        }}
        onDeleted={(id) => setEntries((prev) => prev.filter((e) => e.id !== id))}
      />
    </div>
  );
}
