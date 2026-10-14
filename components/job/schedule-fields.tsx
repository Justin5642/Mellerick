"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildScheduleColumns, DEFAULT_SHIFT_END_TIME, DEFAULT_SHIFT_START_TIME, type ScheduleInput } from "@/lib/scheduling";
import { describeSchedule, scheduleColumnsFromForm, withStartDate } from "@/lib/schedule-form";

interface Props {
  value: ScheduleInput;
  onChange: (next: ScheduleInput) => void;
  /** Blank start date = not scheduled (Overview, New Job). The wizard always needs a date. */
  optional?: boolean;
  /** Rendered between the All day box and the times — the wizard's "already has N jobs" warnings. */
  children?: React.ReactNode;
}

/**
 * Start date, end date, All day and the daily times, plus a one-line summary
 * of what will be booked. The same inputs on every surface that schedules a
 * job, all writing through buildScheduleColumns — a range books the same
 * hours on each weekday between the dates (lib/scheduling.ts).
 */
export function ScheduleFields({ value, onChange, optional = false, children }: Props) {
  const result = scheduleColumnsFromForm(value, { optional });
  const summary = result.ok && value.startDateKey ? describeSchedule(buildScheduleColumns({ ...value, endDateKey: value.endDateKey || value.startDateKey })) : null;
  const noDate = optional && !value.startDateKey;

  function setAllDay(allDay: boolean) {
    // Ticking fills the standard shift into the boxes too, so unticking later
    // starts from 7:00–15:30 rather than from whatever was typed before.
    onChange(allDay ? { ...value, allDay, startTime: DEFAULT_SHIFT_START_TIME, endTime: DEFAULT_SHIFT_END_TIME } : { ...value, allDay });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>Start date</Label>
          <Input type="date" value={value.startDateKey} onChange={(e) => onChange(withStartDate(value, e.target.value))} />
        </div>
        <div className="space-y-2">
          <Label>End date</Label>
          <Input
            type="date"
            value={value.endDateKey || value.startDateKey}
            min={value.startDateKey || undefined}
            disabled={noDate}
            onChange={(e) => onChange({ ...value, endDateKey: e.target.value || value.startDateKey })}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={value.allDay}
          disabled={noDate}
          onChange={(e) => setAllDay(e.target.checked)}
          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
        />
        <span className="text-sm font-medium text-slate-700">
          All day ({DEFAULT_SHIFT_START_TIME.replace(/^0/, "")} – {DEFAULT_SHIFT_END_TIME} each day)
        </span>
      </label>

      {children}

      {!value.allDay && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Start time</Label>
            <Input type="time" value={value.startTime} disabled={noDate} onChange={(e) => onChange({ ...value, startTime: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>End time</Label>
            <Input type="time" value={value.endTime} disabled={noDate} onChange={(e) => onChange({ ...value, endTime: e.target.value })} />
          </div>
        </div>
      )}

      {!result.ok && <p className="text-xs text-red-600">{result.error}</p>}
      {summary && <p className="text-xs text-slate-500">{summary}</p>}
    </div>
  );
}
