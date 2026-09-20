"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { applyScheduleChange, type ScheduleWriteClient } from "@/lib/schedule-dispatch";
import {
  DEFAULT_SHIFT_START_TIME,
  DEFAULT_SHIFT_END_TIME,
  defaultAllDay,
  businessDayRange,
  validateScheduleWindow,
} from "@/lib/scheduling";
import { dateKeyInBusinessTZ, toBusinessInputValue, fromBusinessInputValue } from "@/lib/date";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, ChevronLeft, ChevronRight, User } from "lucide-react";
import { cn } from "@/lib/utils";

interface StaffMember {
  id: string;
  full_name: string;
  role: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  jobNumber: number;
  jobStatus: string;
  staff: StaffMember[];
  currentAssignedTo: string | null;
  currentScheduledStart: string | null;
  currentScheduledEnd: string | null;
}

type Step = "technician" | "time" | "confirm";

function initials(name: string) {
  return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
}

// "07:00" -> "7:00am" — for the All day label, which is the only place a
// "HH:mm" shift constant needs to read as a friendly time-of-day.
function friendlyTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h < 12 ? "am" : "pm";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")}${period}`;
}

/**
 * Prominent "Schedule Job" flow: pick a technician, pick a time (with an "All
 * day" toggle that fills the standard 7:00-3:30 shift but stays editable),
 * then confirm. Reuses applyScheduleChange — the same write+calendar-push
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
  currentAssignedTo,
  currentScheduledStart,
  currentScheduledEnd,
}: Props) {
  const router = useRouter();
  const supabaseClient = createClient();
  const supabase = supabaseClient as unknown as ScheduleWriteClient;

  const [step, setStep] = useState<Step>("technician");
  const [technicianId, setTechnicianId] = useState<string | null>(currentAssignedTo);
  const [dateKey, setDateKey] = useState(() =>
    currentScheduledStart ? dateKeyInBusinessTZ(currentScheduledStart) : dateKeyInBusinessTZ(new Date())
  );
  const [allDay, setAllDay] = useState(true);
  const [startTime, setStartTime] = useState(DEFAULT_SHIFT_START_TIME);
  const [endTime, setEndTime] = useState(DEFAULT_SHIFT_END_TIME);
  const [otherJobsThatDay, setOtherJobsThatDay] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Fresh wizard every time the dialog opens, seeded from whatever the job
  // already has (re-scheduling an already-scheduled job starts from its
  // current technician/time rather than blank).
  useEffect(() => {
    if (!open) return;
    setStep("technician");
    setTechnicianId(currentAssignedTo);
    setDateKey(currentScheduledStart ? dateKeyInBusinessTZ(currentScheduledStart) : dateKeyInBusinessTZ(new Date()));
    if (currentScheduledStart && currentScheduledEnd) {
      setAllDay(false);
      setStartTime(toBusinessInputValue(currentScheduledStart).slice(11));
      setEndTime(toBusinessInputValue(currentScheduledEnd).slice(11));
    } else {
      setAllDay(true);
      setStartTime(DEFAULT_SHIFT_START_TIME);
      setEndTime(DEFAULT_SHIFT_END_TIME);
    }
    setOtherJobsThatDay(null);
  }, [open, currentAssignedTo, currentScheduledStart, currentScheduledEnd]);

  // Smart default: entering the time step (or changing the date there) checks
  // how many OTHER jobs the picked technician already has that day. Zero ->
  // All day stays on (one job filling the shift); one or more -> default it
  // off so this job gets its own custom block instead of everyone getting
  // stamped 7:00-3:30.
  useEffect(() => {
    if (!open || step !== "time" || !technicianId) return;
    let cancelled = false;
    (async () => {
      const { dayStartIso, dayEndIso } = businessDayRange(dateKey);
      const { count, error } = await supabaseClient
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("assigned_to", technicianId)
        .neq("id", jobId)
        .gte("scheduled_start", dayStartIso)
        .lt("scheduled_start", dayEndIso);
      if (cancelled || error) return;
      const n = count ?? 0;
      setOtherJobsThatDay(n);
      const nextAllDay = defaultAllDay(n);
      setAllDay(nextAllDay);
      if (nextAllDay) {
        setStartTime(DEFAULT_SHIFT_START_TIME);
        setEndTime(DEFAULT_SHIFT_END_TIME);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, technicianId, dateKey]);

  function toggleAllDay(next: boolean) {
    setAllDay(next);
    if (next) {
      setStartTime(DEFAULT_SHIFT_START_TIME);
      setEndTime(DEFAULT_SHIFT_END_TIME);
    }
  }

  const technician = staff.find((s) => s.id === technicianId) ?? null;
  const scheduledStartIso = fromBusinessInputValue(`${dateKey}T${startTime}`);
  const scheduledEndIso = fromBusinessInputValue(`${dateKey}T${endTime}`);
  const windowError = validateScheduleWindow(scheduledStartIso, scheduledEndIso);

  async function confirm() {
    if (!technicianId || windowError) return;
    setSaving(true);
    const result = await applyScheduleChange(supabase, jobId, {
      assigned_to: technicianId,
      scheduled_start: scheduledStartIso,
      scheduled_end: scheduledEndIso,
      // A pending job becomes scheduled the moment it's put on the board;
      // anything past that (in progress, on hold, etc.) is left alone.
      ...(jobStatus === "pending" ? { status: "scheduled" } : {}),
    });
    setSaving(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
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
              const active = technicianId === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setTechnicianId(s.id)}
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
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Date</Label>
              <Input type="date" value={dateKey} onChange={(e) => setDateKey(e.target.value)} />
            </div>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => toggleAllDay(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-slate-700">
                All day ({friendlyTime(DEFAULT_SHIFT_START_TIME)} – {friendlyTime(DEFAULT_SHIFT_END_TIME)})
              </span>
            </label>

            {otherJobsThatDay !== null && otherJobsThatDay > 0 && (
              <p className="text-xs text-amber-600">
                {technician?.full_name ?? "This technician"} already has {otherJobsThatDay} job{otherJobsThatDay === 1 ? "" : "s"} that day — set a custom time block below.
              </p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Start time</Label>
                <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>End time</Label>
                <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </div>
            </div>

            {windowError && <p className="text-xs text-red-600">{windowError}</p>}
          </div>
        )}

        {step === "confirm" && (
          <div className="space-y-3">
            <div className="rounded-lg border border-slate-200 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <User className="w-4 h-4 text-slate-400" />
                <span className="text-sm font-medium text-slate-900">{technician?.full_name}</span>
              </div>
              <p className="text-sm text-slate-500">
                {new Date(scheduledStartIso).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", timeZone: "Australia/Melbourne" })}
              </p>
              <p className="text-sm text-slate-500">
                {new Date(scheduledStartIso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", timeZone: "Australia/Melbourne" })}
                {" – "}
                {new Date(scheduledEndIso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", timeZone: "Australia/Melbourne" })}
                {allDay ? " · All day" : ""}
              </p>
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
              onClick={() => setStep(step === "confirm" ? "time" : "technician")}
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
            <Button className="gap-1.5" onClick={() => setStep("time")} disabled={!technicianId}>
              Next
              <ChevronRight className="w-4 h-4" />
            </Button>
          )}
          {step === "time" && (
            <Button className="gap-1.5" onClick={() => setStep("confirm")} disabled={!!windowError}>
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
