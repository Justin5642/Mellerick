"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { applyScheduleChange, setJobAssignments, type ScheduleWriteClient } from "@/lib/schedule-dispatch";
import {
  DEFAULT_SHIFT_START_TIME,
  DEFAULT_SHIFT_END_TIME,
  defaultAllDay,
  businessDayRange,
  occupiesDay,
  scheduleInputFromJob,
  type ScheduleInput,
} from "@/lib/scheduling";
import {
  countTechnicianJobsOnDay,
  describeSchedule,
  scheduleColumnsFromForm,
  scheduleOverlapOrFilter,
  type JobForConflictCount,
} from "@/lib/schedule-form";
import { dateKeyInBusinessTZ } from "@/lib/date";
import { ScheduleFields } from "./schedule-fields";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Check, ChevronLeft, ChevronRight, User } from "lucide-react";
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
  currentAssignedIds: string[];
  currentUserId: string;
  currentScheduledStart: string | null;
  currentScheduledEnd: string | null;
  /** jobs.schedule_daily / schedule_all_day (0071) — so a saved range and All day reopen as saved. */
  currentScheduleDaily?: boolean | null;
  currentScheduleAllDay?: boolean | null;
  costCenters?: CostCenterOption[];
  currentScheduledCostCenterId?: string | null;
}

type Step = "technician" | "time" | "stage" | "notes" | "confirm";

function initials(name: string) {
  return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
}

// What the time step opens with: the job's saved schedule (range, times and
// All day as saved), or today, All day, for a job not yet scheduled.
function initialSchedule(
  start: string | null,
  end: string | null,
  daily: boolean | null | undefined,
  allDay: boolean | null | undefined,
): ScheduleInput {
  const saved = scheduleInputFromJob({ scheduled_start: start, scheduled_end: end, schedule_daily: daily, schedule_all_day: allDay });
  if (saved) return saved;
  const today = dateKeyInBusinessTZ(new Date());
  return { startDateKey: today, endDateKey: today, startTime: DEFAULT_SHIFT_START_TIME, endTime: DEFAULT_SHIFT_END_TIME, allDay: true };
}

/**
 * Prominent "Schedule Job" flow: pick a technician, pick the days and hours
 * (a start and end date — a range books the same hours on each weekday — and
 * an "All day" box for the standard 7:00-15:30 shift), then confirm. Reuses applyScheduleChange — the same write+calendar-push
 * seam as the schedule board's drag-and-drop and the Overview tab's form — so
 * this is one more caller of the existing dispatcher, not a new write path.
 */
export function ScheduleJobDialog({
  open,
  onOpenChange,
  jobId,
  jobNumber,
  jobStatus,
  staff,
  currentAssignedIds,
  currentUserId,
  currentScheduledStart,
  currentScheduledEnd,
  currentScheduleDaily,
  currentScheduleAllDay,
  costCenters = [],
  currentScheduledCostCenterId,
}: Props) {
  const router = useRouter();
  const supabaseClient = createClient();
  const supabase = supabaseClient as unknown as ScheduleWriteClient;

  const [step, setStep] = useState<Step>("technician");
  const [technicianIds, setTechnicianIds] = useState<string[]>(currentAssignedIds);
  const [costCenterId, setCostCenterId] = useState<string | null>(currentScheduledCostCenterId ?? null);
  const [schedule, setSchedule] = useState<ScheduleInput>(() =>
    initialSchedule(currentScheduledStart, currentScheduledEnd, currentScheduleDaily, currentScheduleAllDay)
  );
  // Once All day reflects a decision — the job's saved schedule, or the
  // person ticking/unticking it — the smart default below stops overriding it.
  const allDayDecided = useRef(!!currentScheduledStart);
  const [conflictsByTechnician, setConflictsByTechnician] = useState<Record<string, number>>({});
  const [noteText, setNoteText] = useState("");
  const [saving, setSaving] = useState(false);

  // Fresh wizard every time the dialog opens, seeded from whatever the job
  // already has (re-scheduling an already-scheduled job starts from its
  // current technicians/time rather than blank).
  useEffect(() => {
    if (!open) return;
    setStep("technician");
    setTechnicianIds(currentAssignedIds);
    setCostCenterId(currentScheduledCostCenterId ?? null);
    setSchedule(initialSchedule(currentScheduledStart, currentScheduledEnd, currentScheduleDaily, currentScheduleAllDay));
    allDayDecided.current = !!currentScheduledStart;
    setConflictsByTechnician({});
    setNoteText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentScheduledStart, currentScheduledEnd, currentScheduleDaily, currentScheduleAllDay, currentScheduledCostCenterId]);

  // Smart default: entering the time step (or changing the start date there)
  // checks how many OTHER jobs each picked technician already has on the
  // start day. Zero for all of them -> All day on (one job filling the
  // shift); one or more for any technician -> off, so this job gets its own
  // custom block instead of everyone getting stamped 7:00-15:30. Only until
  // All day has been decided (see allDayDecided); the warnings always show.
  //
  // "Has a job that day" means the job OCCUPIES the day — a multi-day job
  // that started earlier counts, one whose range only spans it across a
  // weekend does not — so the query fetches every job whose span touches the
  // day and occupiesDay() narrows it. And "has" means assigned through
  // job_assignments OR assigned_to (HANDOVER §10 trap 10).
  const startDateKey = schedule.startDateKey;
  useEffect(() => {
    if (!open || step !== "time" || technicianIds.length === 0 || !startDateKey) return;
    let cancelled = false;
    (async () => {
      const { dayStartIso, dayEndIso } = businessDayRange(startDateKey);
      const { data: spanning, error: jobsError } = await supabaseClient
        .from("jobs")
        .select("id, assigned_to, scheduled_start, scheduled_end, schedule_daily")
        .neq("id", jobId)
        .lt("scheduled_start", dayEndIso)
        .or(scheduleOverlapOrFilter(dayStartIso));
      if (cancelled || jobsError) return;
      const otherJobs = ((spanning ?? []) as JobForConflictCount[]).filter((j) => occupiesDay(j, startDateKey));
      let assignments: { job_id: string; staff_id: string }[] = [];
      if (otherJobs.length > 0) {
        const { data, error: assignError } = await supabaseClient
          .from("job_assignments")
          .select("job_id, staff_id")
          .in("job_id", otherJobs.map((j) => j.id))
          .in("staff_id", technicianIds);
        if (cancelled || assignError) return;
        assignments = data ?? [];
      }
      const counts = countTechnicianJobsOnDay(otherJobs, assignments, technicianIds, startDateKey);
      setConflictsByTechnician(counts);
      if (allDayDecided.current) return;
      const nextAllDay = defaultAllDay(Math.max(0, ...Object.values(counts)));
      setSchedule((prev) =>
        nextAllDay
          ? { ...prev, allDay: true, startTime: DEFAULT_SHIFT_START_TIME, endTime: DEFAULT_SHIFT_END_TIME }
          : { ...prev, allDay: false }
      );
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, technicianIds, startDateKey]);

  function changeSchedule(next: ScheduleInput) {
    if (next.allDay !== schedule.allDay) allDayDecided.current = true;
    setSchedule(next);
  }

  const selectedTechnicians = staff.filter((s) => technicianIds.includes(s.id));
  const built = scheduleColumnsFromForm(schedule, { optional: false });
  const hasCostCenters = costCenters.length > 0;

  function toggleTechnician(id: string) {
    setTechnicianIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  }

  async function confirm() {
    if (technicianIds.length === 0 || !built.ok) return;
    setSaving(true);
    const result = await applyScheduleChange(supabase, jobId, {
      ...built.columns,
      scheduled_cost_center_id: costCenterId,
      // A pending job becomes scheduled the moment it's put on the board;
      // anything past that (in progress, on hold, etc.) is left alone.
      ...(jobStatus === "pending" ? { status: "scheduled" } : {}),
    });
    if (!result.ok) {
      setSaving(false);
      toast.error(result.error);
      return;
    }

    const assignmentResult = await setJobAssignments(supabase, jobId, technicianIds);
    if (!assignmentResult.ok) {
      setSaving(false);
      toast.error(assignmentResult.error);
      return;
    }

    // The schedule itself landed — a note failure shouldn't read as the whole
    // operation failing, so it gets its own toast rather than aborting here.
    const trimmed = noteText.trim();
    if (trimmed) {
      const { error: noteError } = await supabaseClient
        .from("job_notes")
        .insert({ job_id: jobId, author_id: currentUserId, content: trimmed, source: "schedule" });
      if (noteError) toast.warning("Job scheduled — note could not be saved");
    }

    setSaving(false);
    if (result.calendarSynced) toast.success("Job scheduled");
    else toast.warning("Job scheduled — Google Calendar not updated");
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule job #{jobNumber}</DialogTitle>
        </DialogHeader>

        {step === "technician" && (
          <div className="space-y-1 max-h-80 overflow-y-auto -mx-1 px-1">
            {staff.length === 0 && <p className="text-sm text-slate-400 py-6 text-center">No active staff found.</p>}
            {staff.map((s) => {
              const active = technicianIds.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleTechnician(s.id)}
                  className={cn(
                    "w-full flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                    active ? "border-blue-500 bg-blue-50" : "border-slate-200 hover:bg-slate-50"
                  )}
                >
                  <Avatar className="w-8 h-8 flex-shrink-0">
                    <AvatarFallback className="text-xs">{initials(s.full_name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900 truncate">{s.full_name}</p>
                    <p className="text-xs text-slate-400 capitalize">{s.role}</p>
                  </div>
                  {active && <Check className="w-4 h-4 text-blue-600 flex-shrink-0" />}
                </button>
              );
            })}
          </div>
        )}

        {step === "time" && (
          <ScheduleFields value={schedule} onChange={changeSchedule}>
            {Object.entries(conflictsByTechnician).map(([staffId, n]) => {
              const name = staff.find((s) => s.id === staffId)?.full_name ?? "This technician";
              return (
                <p key={staffId} className="text-xs text-amber-600">
                  {name} already has {n} job{n === 1 ? "" : "s"} on the start day — consider a custom time block.
                </p>
              );
            })}
          </ScheduleFields>
        )}

        {step === "stage" && (
          <div className="space-y-3">
            <Label>Cost centre (optional)</Label>
            <Select value={costCenterId ?? "none"} onValueChange={(v) => setCostCenterId(v === "none" ? null : v)}>
              <SelectTrigger><SelectValue placeholder="No stage selected" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No stage selected</SelectItem>
                {costCenters.map((cc) => (
                  <SelectItem key={cc.id} value={cc.id}>
                    {cc.name}{cc.po_number ? ` (PO #${cc.po_number})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-slate-400">
              Time logged on this job defaults to this stage at clock-in — the technician can still change it per entry.
            </p>
          </div>
        )}

        {step === "notes" && (
          <div className="space-y-2">
            <Label>Notes for the technician (optional)</Label>
            <Textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="What should they achieve on this job today?"
              rows={4}
            />
            <p className="text-xs text-slate-400">
              Posted to this job&apos;s Notes tab, visible to everyone assigned.
            </p>
          </div>
        )}

        {step === "confirm" && (
          <div className="space-y-3">
            <div className="rounded-lg border border-slate-200 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <User className="w-4 h-4 text-slate-400" />
                <span className="text-sm font-medium text-slate-900">
                  {selectedTechnicians.map((t) => t.full_name).join(", ")}
                </span>
              </div>
              <p className="text-sm text-slate-500">
                {built.ok ? describeSchedule(built.columns) : null}
                {schedule.allDay ? " · All day" : ""}
              </p>
              {costCenters.length > 0 && (
                <p className="text-sm text-slate-500">
                  Stage: {costCenters.find((cc) => cc.id === costCenterId)?.name ?? "None"}
                </p>
              )}
            </div>
            <p className="text-xs text-slate-400">
              This sets the planned schedule block only — actual worked hours are still captured separately via clock-on/clock-off.
            </p>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          {step !== "technician" ? (
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() =>
                setStep(
                  step === "confirm"
                    ? "notes"
                    : step === "notes"
                    ? (hasCostCenters ? "stage" : "time")
                    : step === "stage"
                    ? "time"
                    : "technician"
                )
              }
              disabled={saving}
            >
              <ChevronLeft className="w-4 h-4" />
              Back
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}

          {step === "technician" && (
            <Button className="gap-1.5" onClick={() => setStep("time")} disabled={technicianIds.length === 0}>
              Next
              <ChevronRight className="w-4 h-4" />
            </Button>
          )}
          {step === "time" && (
            <Button className="gap-1.5" onClick={() => setStep(hasCostCenters ? "stage" : "notes")} disabled={!built.ok}>
              Next
              <ChevronRight className="w-4 h-4" />
            </Button>
          )}
          {step === "stage" && (
            <Button className="gap-1.5" onClick={() => setStep("notes")}>
              Next
              <ChevronRight className="w-4 h-4" />
            </Button>
          )}
          {step === "notes" && (
            <Button className="gap-1.5" onClick={() => setStep("confirm")}>
              Next
              <ChevronRight className="w-4 h-4" />
            </Button>
          )}
          {step === "confirm" && (
            <Button className="gap-1.5" onClick={confirm} disabled={saving}>
              <Check className="w-4 h-4" />
              {saving ? "Scheduling…" : "Confirm"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
