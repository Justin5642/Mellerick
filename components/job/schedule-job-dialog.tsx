"use client";

import type { SchedulePrefill } from "@/lib/schedule-existing-job";
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
  BOOKING_NOTE_MAX,
  isEmptyPlan,
  planBookingSave,
  saveBookingPlan,
  scheduleNotesToLog,
  type BookingDraft,
  type BookingWriteClient,
  type JobBookingWithNames,
} from "@/lib/bookings";
import { dateKeyInBusinessTZ, shiftDateKey } from "@/lib/date";
import { bookingLeaveConflicts, describeLeaveConflicts, type ScheduleLeave } from "@/lib/staff-leave";
import { loadScheduleLeave } from "@/lib/staff-leave-data";
import { ScheduleFields } from "./schedule-fields";
import { toast } from "sonner";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KeyboardSafeDialogContent } from "@/components/ui/keyboard-safe-dialog";
import { closedJobScheduleMessage, isJobClosedForScheduling } from "@/lib/job-schedulable";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { BookingCostCentreSelect } from "./booking-cost-centre-select";
import { bookingCostCentreProblem, defaultBookingCostCentre, type BookingLineOption, type CompanyCostCentreOption } from "@/lib/booking-cost-centre";
import { loadCompanyCostCentres } from "@/lib/booking-cost-centre-client";
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
  /** The company cost centre the line is tagged with (0087). */
  cost_centre_id?: string | null;
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
  /** jobs.scheduled_cost_center_id — the first new booking's default cost centre. */
  scheduledCostCenterId?: string | null;
  /** A company cost centre was added to the job as a $0 PO line from here — re-read the job's POs. */
  onCostCentreAdded?: () => void;
  /** The job's saved bookings — the list the dialog opens with. */
  bookings: JobBookingWithNames[];
  /**
   * False when job_bookings is not in this database (one without 0079):
   * the list shown is derived from the job's own window and
   * nothing here can be saved.
   */
  bookingsReady: boolean;
  /** Take the office to where the job's status is changed (Overview). */
  onReopen?: () => void;
  /**
   * Opened from the schedule board's "Schedule an existing job" on a
   * technician's day (`?schedule=1&tech=&day=`): a new row for that
   * technician and day is added and opened, beside any saved bookings.
   */
  prefill?: SchedulePrefill | null;
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
    note: b.note ?? "",
    allDayDecided: true,
  };
}

/**
 * A new row starts from the row above it — same days, hours and cost centre,
 * nobody picked — because the next booking is usually the second technician
 * on the same stage ("Sam rough-in Monday morning"). The first row of an
 * unscheduled job starts today, All day.
 */
/** A new row for the board's clicked technician and day. */
function rowFromPrefill(prefill: SchedulePrefill, defaultCostCenterId: string | null): Row {
  const row = newRow(undefined, defaultCostCenterId);
  const day = prefill.dateKey ?? row.schedule.startDateKey;
  return {
    ...row,
    staffIds: prefill.staffId ? [prefill.staffId] : [],
    schedule: { ...row.schedule, startDateKey: day, endDateKey: day },
  };
}

function newRow(after: Row | undefined, defaultCostCenterId: string | null): Row {
  if (after) {
    return { key: nextKey(), staffIds: [], costCenterId: after.costCenterId ?? defaultCostCenterId, schedule: { ...after.schedule }, note: after.note ?? "", allDayDecided: true };
  }
  const today = dateKeyInBusinessTZ(new Date());
  return {
    key: nextKey(),
    staffIds: [],
    costCenterId: defaultCostCenterId,
    schedule: { startDateKey: today, endDateKey: today, startTime: DEFAULT_SHIFT_START_TIME, endTime: DEFAULT_SHIFT_END_TIME, allDay: true },
    note: "",
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
  scheduledCostCenterId = null,
  onCostCentreAdded,
  bookings,
  bookingsReady,
  onReopen,
  prefill = null,
}: Props) {
  const router = useRouter();
  const supabaseClient = createClient();

  const [rows, setRows] = useState<Row[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  // Staff leave (0112 — a draft, not applied yet) — a booking onto someone's leave day asks first.
  const [leave, setLeave] = useState<ScheduleLeave[]>([]);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const staffById = useMemo(() => new Map(staff.map((s) => [s.id, s])), [staff]);
  // Every booking needs a cost centre (19 Nov 2026): the job's PO lines, plus
  // any added from the picker while this dialog is open, plus the company
  // list for "Add to this job".
  const [addedLines, setAddedLines] = useState<BookingLineOption[]>([]);
  const [company, setCompany] = useState<CompanyCostCentreOption[]>([]);
  const lines: BookingLineOption[] = useMemo(() => {
    const base = costCenters.map((c) => ({ id: c.id, name: c.name, cost_centre_id: c.cost_centre_id ?? null, po_number: c.po_number ?? null }));
    return [...base, ...addedLines.filter((a) => !base.some((b) => b.id === a.id))];
  }, [costCenters, addedLines]);
  const defaultCostCenterId = defaultBookingCostCentre({ scheduled: scheduledCostCenterId, lines });
  const costCenterName = (id: string | null) => (id ? lines.find((cc) => cc.id === id)?.name ?? null : null);
  // A completed or cancelled job is off the schedule board: nothing here may
  // be saved for it (the page's button is disabled too; this covers a dialog
  // already open when the status changed).
  const jobClosed = isJobClosedForScheduling(jobStatus);
  const editable = bookingsReady && !jobClosed;

  // Fresh list every time the dialog opens, seeded from the saved bookings.
  // An unscheduled job opens with one blank row ready to fill in.
  useEffect(() => {
    if (!open) return;
    const seeded = bookings.map(rowFromBooking);
    if (seeded.length === 0 && !editable) {
      setRows([]);
      setEditingKey(null);
    } else if (prefill) {
      const added = rowFromPrefill(prefill, defaultCostCenterId);
      setRows([...seeded, added]);
      setEditingKey(added.key);
    } else if (seeded.length === 0) {
      const first = newRow(undefined, defaultCostCenterId);
      setRows([first]);
      setEditingKey(first.key);
    } else {
      setRows(seeded);
      setEditingKey(null);
    }
    setConflicts({});
    setLeaveConfirm(false);
    // The default cost centre is read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bookings, editable, prefill]);

  // The company cost centres, once per opening ("Add to this job").
  useEffect(() => {
    if (!open) return;
    let live = true;
    void loadCompanyCostCentres(supabaseClient).then((list) => {
      if (live) setCompany(list);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Leave from last week to a year ahead, read once per opening. [] before
  // 0112 (or on any failure): no warnings, nothing else changes.
  useEffect(() => {
    if (!open) return;
    let live = true;
    const today = dateKeyInBusinessTZ(new Date());
    void loadScheduleLeave(supabaseClient, shiftDateKey(today, -7), shiftDateKey(today, 366)).then((rows) => {
      if (live) setLeave(rows);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
    const row = newRow(rows[rows.length - 1], defaultCostCenterId);
    setRows((prev) => [...prev, row]);
    setEditingKey(row.key);
  }

  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
    if (editingKey === key) setEditingKey(null);
  }

  // Rows that would book someone on a day they're on leave, from today on.
  // A saved booking left exactly as it was isn't re-warned on every save —
  // the board and the job already flag it "Needs reassigning".
  const leaveWarnings = useMemo(() => {
    const out = new Map<string, string[]>();
    if (leave.length === 0) return out;
    const today = dateKeyInBusinessTZ(new Date());
    for (const r of rows) {
      const built = scheduleColumnsFromForm(r.schedule, { optional: false });
      if (!built.ok) continue;
      const window = buildBookingWindow(r.schedule);
      const saved = r.bookingId ? bookings.find((b) => b.id === r.bookingId) : undefined;
      const lines: string[] = [];
      for (const staffId of r.staffIds) {
        const unchanged =
          saved &&
          saved.staff_id === staffId &&
          Date.parse(saved.starts_at) === Date.parse(window.starts_at) &&
          (saved.ends_at === null ? window.ends_at === null : window.ends_at !== null && Date.parse(saved.ends_at) === Date.parse(window.ends_at)) &&
          saved.daily === window.daily;
        if (unchanged) continue;
        const hits = bookingLeaveConflicts({ staff_id: staffId, ...window }, leave, today);
        if (hits.length > 0) lines.push(describeLeaveConflicts(staffById.get(staffId)?.full_name ?? "Technician", hits));
      }
      if (lines.length > 0) out.set(r.key, lines);
    }
    return out;
  }, [rows, leave, bookings, staffById]);
  // Any edit after the warning was shown asks again.
  useEffect(() => setLeaveConfirm(false), [rows]);

  // Every row must be a valid schedule before anything is written.
  const rowErrors = useMemo(() => {
    const errors = new Map<string, string>();
    for (const r of rows) {
      const built = scheduleColumnsFromForm(r.schedule, { optional: false });
      if (!built.ok) errors.set(r.key, built.error);
    }
    return errors;
  }, [rows]);
  // Rows with no cost centre yet — Save waits for every one to be picked.
  const missingCostCentre = useMemo(() => rows.filter((r) => bookingCostCentreProblem(r.costCenterId)).map((r) => r.key), [rows]);

  async function save() {
    if (!editable || rowErrors.size > 0) return;
    if (missingCostCentre.length > 0) {
      // Open the first row that still needs one, so the office sees why.
      setEditingKey(missingCostCentre[0]);
      toast.error("Pick a cost centre for every booking.");
      return;
    }
    // Booking onto leave: say so and wait for "Book anyway" — never silent.
    if (leaveWarnings.size > 0 && !leaveConfirm) {
      setLeaveConfirm(true);
      return;
    }
    const plan = planBookingSave(jobId, bookings, rows);
    // New or changed booking notes also go to the job's Notes history.
    const notesToLog = scheduleNotesToLog(bookings, rows);
    if (isEmptyPlan(plan) && notesToLog.length === 0) {
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
    // `count`: a write RLS filters out "succeeds" against zero rows.
    if (jobStatus === "pending" && rows.length > 0) {
      const { error: statusError, count } = await supabaseClient
        .from("jobs")
        .update({ status: "scheduled" }, { count: "exact" })
        .eq("id", jobId);
      if (statusError || count === 0) toast.warning("Bookings saved — the job's status could not be set to Scheduled");
    }

    // Each booking keeps its own note (job_bookings.note — 0109) — that is what
    // the technician sees, and only while the booking is current. A copy of
    // each new or changed note goes to Notes & Activity as the history. The
    // bookings landed — a note failure shouldn't read as the whole operation
    // failing, so it gets its own toast rather than aborting here.
    if (notesToLog.length > 0) {
      const { error: noteError } = await supabaseClient
        .from("job_notes")
        .insert(notesToLog.map((content) => ({ job_id: jobId, author_id: currentUserId, content, source: "schedule" })));
      if (noteError) toast.warning("Bookings saved — the note could not be added to the job's Notes");
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
      <KeyboardSafeDialogContent
        className="sm:max-w-lg"
        header={
          <DialogHeader>
            <DialogTitle>Schedule job #{jobNumber}</DialogTitle>
          </DialogHeader>
        }
        footer={
          <div className="space-y-2">
            {leaveConfirm && leaveWarnings.size > 0 && (
              <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
                <p className="font-semibold">Not available then — book anyway?</p>
                {[...leaveWarnings.values()].flat().map((line) => (
                  <p key={line} className="text-xs">{line}</p>
                ))}
              </div>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <Button variant="outline" onClick={() => (leaveConfirm ? setLeaveConfirm(false) : onOpenChange(false))} disabled={saving}>
                {leaveConfirm ? "Go back" : "Cancel"}
              </Button>
              {editable && (
                <Button className="gap-1.5" onClick={save} disabled={saving || rowErrors.size > 0}>
                  <Check className="w-4 h-4" />
                  {saving ? "Saving…" : leaveConfirm ? "Book anyway" : "Save schedule"}
                </Button>
              )}
            </div>
          </div>
        }
      >
        {jobClosed && (
          <div className="text-sm rounded-md bg-amber-50 text-amber-800 px-3 py-2 space-y-2" role="alert">
            <p>{closedJobScheduleMessage(jobStatus)}</p>
            {onReopen && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  onOpenChange(false);
                  onReopen();
                }}
              >
                Change the job&apos;s status
              </Button>
            )}
          </div>
        )}

        <p className="text-xs text-slate-500">
          Each booking is a technician&apos;s own time on this job. Pick several technicians on one booking to book each of
          them on the same days and hours.
        </p>
        {!bookingsReady && !jobClosed && (
          <p className="text-xs rounded-md bg-amber-50 text-amber-800 px-3 py-2">
            Per-technician bookings aren&apos;t switched on in the database yet, so this schedule can&apos;t be changed here.
          </p>
        )}

        <div className="space-y-2">
          {rows.length === 0 && (
            <p className="text-sm text-slate-400 py-4 text-center border border-dashed border-slate-200 rounded-lg">
              {editable ? "No bookings — saving leaves this job unscheduled." : "No bookings."}
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
                    disabled={!editable}
                  >
                    <p className={cn("text-sm font-medium truncate", row.staffIds.length === 0 ? "text-amber-700" : "text-slate-900")}>
                      {namesOf(row.staffIds, staffById)}
                      {cc && <span className="font-normal text-cyan-700"> · {cc}</span>}
                      {!row.costCenterId && editable && <span className="font-medium text-red-600"> · Pick a cost centre</span>}
                    </p>
                    <p className={cn("text-xs truncate", error ? "text-red-600" : "text-slate-500")}>
                      {error ?? (window ? describeBooking(window) : "")}
                      {!error && row.schedule.allDay ? " · All day" : ""}
                    </p>
                    {row.note?.trim() && <p className="text-xs text-amber-700 truncate">Note: {row.note.trim()}</p>}
                    {(leaveWarnings.get(row.key) ?? []).map((line) => (
                      <p key={line} className="text-xs font-medium text-rose-700">{line}</p>
                    ))}
                  </button>
                  {editable && (
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

                    <div className="space-y-2">
                      <Label htmlFor={`cc-${row.key}`}>Cost centre</Label>
                      <BookingCostCentreSelect
                        id={`cc-${row.key}`}
                        jobId={jobId}
                        value={row.costCenterId}
                        lines={lines}
                        company={company}
                        onChange={(lineId) => updateRow(row.key, (r) => ({ ...r, costCenterId: lineId }))}
                        onLineAdded={(line) => {
                          setAddedLines((prev) => (prev.some((l) => l.id === line.id) ? prev : [...prev, line]));
                          onCostCentreAdded?.();
                        }}
                        showProblem
                      />
                      <p className="text-xs text-slate-400">
                        What this booking&apos;s work is costed to. Time logged on it defaults to this cost centre at
                        clock-in. A cost centre the job doesn&apos;t have yet is added to its PO with nothing allocated.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Note for this booking (optional)</Label>
                      <Textarea
                        value={row.note ?? ""}
                        onChange={(e) => updateRow(row.key, (r) => ({ ...r, note: e.target.value }))}
                        placeholder="What should they achieve on this booking?"
                        maxLength={BOOKING_NOTE_MAX}
                        rows={3}
                      />
                      <p className="text-xs text-slate-400">
                        Shown at the top of the job to the technician on this booking until it is over. A copy goes to the
                        job&apos;s Notes. Bookings set the planned time only — worked hours are still captured by
                        clock-on/clock-off.
                      </p>
                    </div>

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

          {editable && (
            <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={addRow}>
              <Plus className="w-4 h-4" />
              Add booking
            </Button>
          )}
        </div>
      </KeyboardSafeDialogContent>
    </Dialog>
  );
}
