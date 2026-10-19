"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { pushJobToCalendar } from "@/lib/schedule-dispatch";
import {
  DEFAULT_SHIFT_START_TIME,
  DEFAULT_SHIFT_END_TIME,
  defaultAllDay,
  businessDayRange,
  occupiesDay,
  type ScheduleInput,
} from "@/lib/scheduling";
import { scheduleColumnsFromForm } from "@/lib/schedule-form";
import {
  bookingScheduleInput,
  bookingWindow,
  buildBookingWindow,
  describeBooking,
  isEmptyPlan,
  planBookingSave,
  saveBookingPlan,
  type BookingDraft,
  type BookingWriteClient,
  type JobBookingWithNames,
} from "@/lib/bookings";
import { dateKeyInBusinessTZ } from "@/lib/date";
import { ScheduleFields } from "./schedule-fields";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Check, ChevronDown, Pencil, Plus, Trash2, User } from "lucide-react";
import { cn } from "@/lib/utils";

interface StaffMember {
  id: string;
  full_name: string;
  role: string;
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
  jobId: string;
  jobNumber: number;
  jobStatus: string;
  staff: StaffMember[];
  currentUserId: string;
  costCenters?: CostCenterOption[];
  /** The job's saved bookings — the list the dialog opens with. */
  bookings: JobBookingWithNames[];
  /**
   * False when job_bookings is not in this database (one without 0079):
   * the list shown is derived from the job's own window and
   * nothing here can be saved.
   */
  bookingsReady: boolean;
}

/** A dialog row: what will be saved, plus local UI state. */
type Row = BookingDraft & {
  key: string;
  /** All day reflects a decision (a saved booking, a copied row, or a click) — the smart default stops touching it. */
  allDayDecided: boolean;
};

let rowSeq = 0;
const nextKey = () => `row-${++rowSeq}`;

function rowFromBooking(b: JobBookingWithNames): Row {
  return {
    key: b.id,
    bookingId: b.id,
    staffIds: b.staff_id ? [b.staff_id] : [],
    costCenterId: b.cost_center_id,
    schedule: bookingScheduleInput(b),
    allDayDecided: true,
  };
}

/**
 * A new row starts from the row above it — same days, hours and cost centre,
 * nobody picked — because the next booking is usually the second technician
 * on the same stage ("Sam rough-in Monday morning"). The first row of an
 * unscheduled job starts today, All day.
 */
function newRow(after: Row | undefined): Row {
  if (after) return { key: nextKey(), staffIds: [], costCenterId: after.costCenterId, schedule: { ...after.schedule }, allDayDecided: true };
  const today = dateKeyInBusinessTZ(new Date());
  return {
    key: nextKey(),
    staffIds: [],
    costCenterId: null,
    schedule: { startDateKey: today, endDateKey: today, startTime: DEFAULT_SHIFT_START_TIME, endTime: DEFAULT_SHIFT_END_TIME, allDay: true },
    allDayDecided: false,
  };
}

/** "Dave, Sam" / "Unassigned". */
function namesOf(staffIds: string[], staffById: Map<string, StaffMember>) {
  if (staffIds.length === 0) return "Unassigned";
  return staffIds.map((id) => staffById.get(id)?.full_name ?? "Technician").join(", ");
}

/**
 * The job's Schedule dialog: its BOOKINGS as a list (job_bookings — 0079, a
 * draft not applied yet). Each row is "these technicians, this cost centre,
 * these days and hours": the same date range / All day / daily hours as every
 * other schedule input (ScheduleFields, lib/scheduling.ts). Picking several
 * technicians on one row books each of them on that window; a row with nobody
 * is an unassigned booking. Rows are added, edited and removed here and
 * written together on Save (planBookingSave → saveBookingPlan); the database
 * derives the job's own window and crew from them, and the job's calendar
 * events — one per booking — are pushed afterwards.
 */
export function ScheduleJobDialog({
  open,
  onOpenChange,
  jobId,
  jobNumber,
  jobStatus,
  staff,
  currentUserId,
  costCenters = [],
  bookings,
  bookingsReady,
}: Props) {
  const router = useRouter();
  const supabaseClient = createClient();

  const [rows, setRows] = useState<Row[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Record<string, number>>({});
  const [noteText, setNoteText] = useState("");
  const [saving, setSaving] = useState(false);
  const staffById = useMemo(() => new Map(staff.map((s) => [s.id, s])), [staff]);
  const costCenterName = (id: string | null) => (id ? costCenters.find((cc) => cc.id === id)?.name ?? null : null);

  // Fresh list every time the dialog opens, seeded from the saved bookings.
  // An unscheduled job opens with one blank row ready to fill in.
  useEffect(() => {
    if (!open) return;
    const seeded = bookings.map(rowFromBooking);
    if (seeded.length === 0) {
      const first = newRow(undefined);
      setRows([first]);
      setEditingKey(first.key);
    } else {
      setRows(seeded);
      setEditingKey(null);
    }
    setConflicts({});
    setNoteText("");
  }, [open, bookings]);

  const editing = rows.find((r) => r.key === editingKey) ?? null;

  // Warnings for the row being edited: how many OTHER jobs each picked
  // technician already has bookings on for the row's start day — the same
  // check the old wizard made against the job windows, now against bookings
  // (each technician's own time). Until the row's All day has been decided it
  // also sets the smart default: nobody else booked → All day (one job filling
  // the shift); someone busy → a custom block.
  //
  // "Has a booking that day" means it OCCUPIES the day — a multi-day booking
  // that started earlier counts, one whose range only spans the day across a
  // weekend does not — so the query fetches every booking whose span touches
  // the day and occupiesDay() narrows it.
  const editingStaffKey = editing?.staffIds.join(",") ?? "";
  const editingStart = editing?.schedule.startDateKey ?? "";
  const editingRowKey = editing?.key ?? null;
  const lastConflictRequest = useRef(0);
  useEffect(() => {
    if (!open || !editingRowKey || !editingStaffKey || !editingStart || !bookingsReady) {
      setConflicts({});
      return;
    }
    const request = ++lastConflictRequest.current;
    const staffIds = editingStaffKey.split(",");
    (async () => {
      const { dayStartIso, dayEndIso } = businessDayRange(editingStart);
      const { data, error } = await supabaseClient
        .from("job_bookings")
        .select("job_id, staff_id, starts_at, ends_at, daily, all_day")
        .neq("job_id", jobId)
        .in("staff_id", staffIds)
        .lt("starts_at", dayEndIso)
        .or(`ends_at.gt.${dayStartIso},and(ends_at.is.null,starts_at.gte.${dayStartIso})`);
      if (request !== lastConflictRequest.current || error) return;
      const jobsByStaff = new Map<string, Set<string>>();
      for (const b of data ?? []) {
        if (!b.staff_id || !occupiesDay(bookingWindow(b), editingStart)) continue;
        let set = jobsByStaff.get(b.staff_id);
        if (!set) jobsByStaff.set(b.staff_id, (set = new Set()));
        set.add(b.job_id);
      }
      const counts: Record<string, number> = {};
      for (const [id, set] of jobsByStaff) counts[id] = set.size;
      setConflicts(counts);
      setRows((prev) =>
        prev.map((r) => {
          if (r.key !== editingRowKey || r.allDayDecided) return r;
          const allDay = defaultAllDay(Math.max(0, ...Object.values(counts)));
          return {
            ...r,
            schedule: allDay
              ? { ...r.schedule, allDay, startTime: DEFAULT_SHIFT_START_TIME, endTime: DEFAULT_SHIFT_END_TIME }
              : { ...r.schedule, allDay },
          };
        }),
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingRowKey, editingStaffKey, editingStart, bookingsReady, jobId]);

  function updateRow(key: string, change: (row: Row) => Row) {
    setRows((prev) => prev.map((r) => (r.key === key ? change(r) : r)));
  }

  function changeSchedule(key: string, next: ScheduleInput) {
    updateRow(key, (r) => ({ ...r, schedule: next, allDayDecided: r.allDayDecided || next.allDay !== r.schedule.allDay }));
  }

  function toggleTechnician(key: string, staffId: string) {
    updateRow(key, (r) => ({
      ...r,
      staffIds: r.staffIds.includes(staffId) ? r.staffIds.filter((id) => id !== staffId) : [...r.staffIds, staffId],
    }));
  }

  function addRow() {
    const row = newRow(rows[rows.length - 1]);
    setRows((prev) => [...prev, row]);
    setEditingKey(row.key);
  }

  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
    if (editingKey === key) setEditingKey(null);
  }

  // Every row must be a valid schedule before anything is written.
  const rowErrors = useMemo(() => {
    const errors = new Map<string, string>();
    for (const r of rows) {
      const built = scheduleColumnsFromForm(r.schedule, { optional: false });
      if (!built.ok) errors.set(r.key, built.error);
    }
    return errors;
  }, [rows]);

  async function save() {
    if (!bookingsReady || rowErrors.size > 0) return;
    const plan = planBookingSave(jobId, bookings, rows);
    const trimmed = noteText.trim();
    if (isEmptyPlan(plan) && !trimmed) {
      onOpenChange(false);
      return;
    }
    setSaving(true);
    // Narrowed for the same TS2589 reason as the board (lib/bookings.ts).
    const result = await saveBookingPlan(supabaseClient as unknown as BookingWriteClient, plan);
    if (!result.ok) {
      setSaving(false);
      toast.error(result.error);
      if (result.partial) {
        // Some rows landed: show what the database now holds rather than a
        // dialog that no longer matches it.
        onOpenChange(false);
        router.refresh();
      }
      return;
    }

    // A pending job becomes scheduled the moment it has a booking; anything
    // past that (in progress, on hold, etc.) is left alone. A status-only
    // write: it is not a schedule column, so the compatibility trigger
    // leaves the bookings just written alone.
    if (jobStatus === "pending" && rows.length > 0) {
      const { error: statusError } = await supabaseClient.from("jobs").update({ status: "scheduled" }).eq("id", jobId);
      if (statusError) toast.warning("Bookings saved — the job's status could not be set to Scheduled");
    }

    // The bookings landed — a note failure shouldn't read as the whole
    // operation failing, so it gets its own toast rather than aborting here.
    if (trimmed) {
      const { error: noteError } = await supabaseClient
        .from("job_notes")
        .insert({ job_id: jobId, author_id: currentUserId, content: trimmed, source: "schedule" });
      if (noteError) toast.warning("Bookings saved — note could not be saved");
    }

    // One calendar event per booking: created, moved, retitled or removed
    // by the sync route from what is now in the database.
    const calendarSynced = isEmptyPlan(plan) ? true : await pushJobToCalendar(jobId);
    setSaving(false);
    if (calendarSynced) toast.success("Schedule saved");
    else toast.warning("Schedule saved — Google Calendar not updated");
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Schedule job #{jobNumber}</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-slate-500">
          Each booking is a technician&apos;s own time on this job. Pick several technicians on one booking to book each of
          them on the same days and hours.
        </p>
        {!bookingsReady && (
          <p className="text-xs rounded-md bg-amber-50 text-amber-800 px-3 py-2">
            Per-technician bookings aren&apos;t switched on in the database yet, so this schedule can&apos;t be changed here.
          </p>
        )}

        <div className="space-y-2">
          {rows.length === 0 && (
            <p className="text-sm text-slate-400 py-4 text-center border border-dashed border-slate-200 rounded-lg">
              No bookings — saving leaves this job unscheduled.
            </p>
          )}
          {rows.map((row) => {
            const isEditing = row.key === editingKey;
            const error = rowErrors.get(row.key);
            const window = error ? null : buildBookingWindow({ ...row.schedule, endDateKey: row.schedule.endDateKey || row.schedule.startDateKey });
            const cc = costCenterName(row.costCenterId);
            return (
              <div key={row.key} className={cn("rounded-lg border", isEditing ? "border-blue-400" : "border-slate-200")}>
                <div className="flex items-start gap-2 px-3 py-2.5">
                  <User className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
                  <button
                    type="button"
                    className="flex-1 min-w-0 text-left"
                    onClick={() => setEditingKey(isEditing ? null : row.key)}
                    disabled={!bookingsReady}
                  >
                    <p className={cn("text-sm font-medium truncate", row.staffIds.length === 0 ? "text-amber-700" : "text-slate-900")}>
                      {namesOf(row.staffIds, staffById)}
                      {cc && <span className="font-normal text-cyan-700"> · {cc}</span>}
                    </p>
                    <p className={cn("text-xs truncate", error ? "text-red-600" : "text-slate-500")}>
                      {error ?? (window ? describeBooking(window) : "")}
                      {!error && row.schedule.allDay ? " · All day" : ""}
                    </p>
                  </button>
                  {bookingsReady && (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-slate-400"
                        aria-label={isEditing ? "Done editing" : "Edit booking"}
                        onClick={() => setEditingKey(isEditing ? null : row.key)}
                      >
                        {isEditing ? <ChevronDown className="w-4 h-4" /> : <Pencil className="w-3.5 h-3.5" />}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-slate-400 hover:text-red-600"
                        aria-label="Remove booking"
                        onClick={() => removeRow(row.key)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </>
                  )}
                </div>

                {isEditing && (
                  <div className="border-t border-slate-100 px-3 py-3 space-y-4">
                    <div className="space-y-2">
                      <Label>Technicians</Label>
                      {staff.length === 0 && <p className="text-xs text-slate-400">No active staff found.</p>}
                      <div className="flex flex-wrap gap-1.5">
                        {staff.map((s) => {
                          const active = row.staffIds.includes(s.id);
                          return (
                            <button
                              key={s.id}
                              type="button"
                              onClick={() => toggleTechnician(row.key, s.id)}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
                                active ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600 hover:bg-slate-50",
                              )}
                            >
                              {active && <Check className="w-3 h-3" />}
                              {s.full_name}
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-xs text-slate-400">Nobody picked = an unassigned booking.</p>
                    </div>

                    {costCenters.length > 0 && (
                      <div className="space-y-2">
                        <Label>Cost centre (optional)</Label>
                        <Select
                          value={row.costCenterId ?? "none"}
                          onValueChange={(v) => updateRow(row.key, (r) => ({ ...r, costCenterId: v === "none" || !v ? null : v }))}
                        >
                          <SelectTrigger><SelectValue placeholder="No stage selected" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No stage selected</SelectItem>
                            {costCenters.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name}{c.po_number ? ` (PO #${c.po_number})` : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-slate-400">
                          Time logged on this job defaults to this stage at clock-in — the technician can still change it per entry.
                        </p>
                      </div>
                    )}

                    <ScheduleFields value={row.schedule} onChange={(next) => changeSchedule(row.key, next)}>
                      {Object.entries(conflicts).map(([staffId, n]) =>
                        row.staffIds.includes(staffId) ? (
                          <p key={staffId} className="text-xs text-amber-600">
                            {staffById.get(staffId)?.full_name ?? "This technician"} already has {n} other job{n === 1 ? "" : "s"} on the start day — consider a custom time block.
                          </p>
                        ) : null,
                      )}
                    </ScheduleFields>
                  </div>
                )}
              </div>
            );
          })}

          {bookingsReady && (
            <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={addRow}>
              <Plus className="w-4 h-4" />
              Add booking
            </Button>
          )}
        </div>

        {bookingsReady && (
          <div className="space-y-2">
            <Label>Notes for the technicians (optional)</Label>
            <Textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="What should they achieve on this job?"
              rows={3}
            />
            <p className="text-xs text-slate-400">
              Posted to this job&apos;s Notes tab, visible to everyone assigned. Bookings set the planned time only — worked
              hours are still captured by clock-on/clock-off.
            </p>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          {bookingsReady && (
            <Button className="gap-1.5" onClick={save} disabled={saving || rowErrors.size > 0}>
              <Check className="w-4 h-4" />
              {saving ? "Saving…" : "Save schedule"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
