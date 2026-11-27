// What was ACTUALLY clocked, beside what was booked, on the schedule
// (Justin, 27 Nov 2026: "No matter what time is scheduled, it needs to show
// what was actually clocked onto — when someone clocks on and off, it shows
// up on the schedule"). Display only: nothing here writes a booking.
//
// Pure rules, no I/O. The web board reads the entries in
// lib/booking-attendance-data.ts (loadActualEntries) and draws them in
// components/schedule/team-schedule-view.tsx; the phone's office Schedule tab
// reads them in mobile/lib/data/reads/attendance.ts (listActualEntries) and
// draws them in mobile/components/schedule/ScheduleGrid.tsx.
//
// MIRRORED byte for byte below the imports at mobile/lib/scheduleActuals.ts
// (tests/unit/schedule-actuals-mirror.test.ts) — change this file first, then
// copy its body.
//
// The rules:
// - WORK entries only. Travel is never drawn (it isn't time on the job, and
//   the over-hours / scoreboard rules leave it out too).
// - An entry is split into Melbourne-day spans (0071's day boundaries,
//   measured with businessDayRange — never by comparing timestamp text): a
//   night shift across midnight is two spans.
// - Still clocked on: the span runs to now, but never more than
//   MAX_OPEN_HOURS after the clock-on — past that it is a forgotten
//   clock-off, drawn to the cap and flagged `stale`.
// - A span is MATCHED to the same technician's booking on the same job on the
//   same day (booking days by 0071/0079: scheduleDays(bookingWindow(b))) —
//   the one it overlaps most, else the first. Anything else is UNBOOKED
//   ("Clocked — not booked"), including time on a job that day booked only
//   for someone else.
// - Completed jobs are treated like any other: the clocked time still shows.
//
// No money anywhere: ids, times and hours only.
import { BUSINESS_TIME_ZONE, dateKeyInBusinessTZ, shiftDateKey } from "./date";
import { businessDayRange, scheduleDays } from "./scheduling";
import { bookingWindow } from "./bookings";
import { dayBlockGeometry, minutesIntoDay, packLanes } from "./schedule-grid";

/** Longer than this still clocked on = a forgotten clock-off; drawn to here and flagged. */
export const MAX_OPEN_HOURS = 16;
/** A closed entry longer than this many days is drawn only this far (a typo'd clock-off). */
export const MAX_SPAN_DAYS = 7;

export const CLOCKED_NOT_BOOKED = "Clocked — not booked";

/** A WORK time entry, as much of it as the rule reads (no hours column, no rate). */
export interface ActualEntry {
  id: string;
  job_id: string | null;
  staff_id: string | null;
  clock_in: string | null;
  clock_out: string | null;
  entry_type?: string | null;
}

/** What the rule needs of a booking. */
export interface ActualBooking {
  id: string;
  job_id: string;
  staff_id: string | null;
  starts_at: string;
  ends_at: string | null;
  daily: boolean;
  all_day?: boolean;
}

/** One entry's time on one Melbourne day. */
export interface ActualSpan {
  entryId: string;
  jobId: string;
  staffId: string;
  dateKey: string;
  /** Clipped to the day (and, for an open entry, to now / the cap). */
  startIso: string;
  endIso: string;
  /** Still clocked on (no clock-off yet). */
  open: boolean;
  /** Open for more than MAX_OPEN_HOURS — a forgotten clock-off. */
  stale: boolean;
  hours: number;
  /** The booking it belongs to (same technician, job and day); null = clocked, not booked. */
  bookingId: string | null;
}

/** Everything the boards draw, as plain objects (it crosses the server → client boundary). */
export interface ScheduleActuals {
  /** `${bookingId}|${dateKey}` → that booking's clocked spans that day. */
  byBooking: Record<string, ActualSpan[]>;
  /** Spans with no booking, by `${staffId}|${dateKey}`. */
  unbooked: Record<string, ActualSpan[]>;
  /** Clocked hours by `${staffId}|${dateKey}` (matched + unbooked). */
  clockedHours: Record<string, number>;
}

const HOUR_MS = 3600000;

function roundHours(ms: number): number {
  return Math.round((ms / HOUR_MS) * 100) / 100;
}

/** A work entry's Melbourne-day spans (no booking matched yet). Bad or travel entries give none. */
export function entrySpans(entry: ActualEntry, nowMs: number): ActualSpan[] {
  if (!entry.job_id || !entry.staff_id || !entry.clock_in) return [];
  if (entry.entry_type && entry.entry_type !== "work") return [];
  const start = Date.parse(entry.clock_in);
  if (!Number.isFinite(start)) return [];
  const open = !entry.clock_out;
  let end: number;
  let stale = false;
  if (open) {
    const cap = start + MAX_OPEN_HOURS * HOUR_MS;
    stale = nowMs > cap;
    end = Math.min(nowMs, cap);
  } else {
    end = Date.parse(entry.clock_out as string);
    if (!Number.isFinite(end)) return [];
    end = Math.min(end, start + MAX_SPAN_DAYS * 24 * HOUR_MS);
  }
  if (end <= start) return [];
  const spans: ActualSpan[] = [];
  let key = dateKeyInBusinessTZ(new Date(start));
  for (let i = 0; i <= MAX_SPAN_DAYS + 1; i++) {
    const day = businessDayRange(key);
    const dayStart = Date.parse(day.dayStartIso);
    const dayEnd = Date.parse(day.dayEndIso);
    if (dayStart >= end) break;
    const s = Math.max(start, dayStart);
    const e = Math.min(end, dayEnd);
    if (e > s) {
      spans.push({
        entryId: entry.id,
        jobId: entry.job_id,
        staffId: entry.staff_id,
        dateKey: key,
        startIso: new Date(s).toISOString(),
        endIso: new Date(e).toISOString(),
        open,
        stale,
        hours: roundHours(e - s),
        bookingId: null,
      });
    }
    key = shiftDateKey(key, 1);
  }
  return spans;
}

function overlapMs(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  return Math.max(0, Math.min(Date.parse(aEnd), Date.parse(bEnd)) - Math.max(Date.parse(aStart), Date.parse(bStart)));
}

/**
 * Every work entry's spans, each matched to its booking where there is one.
 * `nowMs` is the clock an open entry runs to.
 */
export function scheduleActuals(entries: readonly ActualEntry[], bookings: readonly ActualBooking[], nowMs: number): ScheduleActuals {
  // staff|job|day → that technician's bookings on the job that day, with the day's window.
  const booked = new Map<string, { id: string; startIso: string; endIso: string }[]>();
  for (const b of bookings) {
    if (!b.staff_id) continue;
    for (const d of scheduleDays(bookingWindow({ starts_at: b.starts_at, ends_at: b.ends_at, daily: b.daily, all_day: !!b.all_day }))) {
      const k = `${b.staff_id}|${b.job_id}|${d.dateKey}`;
      const list = booked.get(k) ?? [];
      list.push({ id: b.id, startIso: d.startIso, endIso: d.endIso });
      booked.set(k, list);
    }
  }
  const out: ScheduleActuals = { byBooking: {}, unbooked: {}, clockedHours: {} };
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    for (const span of entrySpans(entry, nowMs)) {
      const candidates = booked.get(`${span.staffId}|${span.jobId}|${span.dateKey}`) ?? [];
      let best: { id: string; overlap: number } | null = null;
      for (const c of candidates) {
        const overlap = overlapMs(span.startIso, span.endIso, c.startIso, c.endIso);
        if (!best || overlap > best.overlap) best = { id: c.id, overlap };
      }
      const placed = { ...span, bookingId: best?.id ?? null };
      const dayKey = `${span.staffId}|${span.dateKey}`;
      const bucket = placed.bookingId ? out.byBooking : out.unbooked;
      const bucketKey = placed.bookingId ? `${placed.bookingId}|${span.dateKey}` : dayKey;
      if (!bucket[bucketKey]) bucket[bucketKey] = [];
      bucket[bucketKey].push(placed);
      out.clockedHours[dayKey] = Math.round(((out.clockedHours[dayKey] ?? 0) + span.hours) * 100) / 100;
    }
  }
  const byStart = (a: ActualSpan, b: ActualSpan) => Date.parse(a.startIso) - Date.parse(b.startIso) || a.entryId.localeCompare(b.entryId);
  for (const list of Object.values(out.byBooking)) list.sort(byStart);
  for (const list of Object.values(out.unbooked)) list.sort(byStart);
  return out;
}

export const NO_ACTUALS: ScheduleActuals = { byBooking: {}, unbooked: {}, clockedHours: {} };

/** A booking's clocked spans on a day ([] when none, or no actuals). */
export function actualsForBooking(actuals: ScheduleActuals | null | undefined, bookingId: string, dateKey: string): ActualSpan[] {
  return actuals?.byBooking[`${bookingId}|${dateKey}`] ?? [];
}

/** A technician's unbooked spans on a day. */
export function unbookedFor(actuals: ScheduleActuals | null | undefined, staffId: string | null, dateKey: string): ActualSpan[] {
  return staffId ? actuals?.unbooked[`${staffId}|${dateKey}`] ?? [] : [];
}

/** A technician's clocked hours on a day (0 when none). */
export function clockedHoursFor(actuals: ScheduleActuals | null | undefined, staffId: string | null, dateKey: string): number {
  return staffId ? actuals?.clockedHours[`${staffId}|${dateKey}`] ?? 0 : 0;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

let clockFormatter: Intl.DateTimeFormat | null = null;

/** "7:42" / "3:10" — Melbourne wall-clock, 12-hour, no am/pm (the schedule's context says which). */
export function clockTime(iso: string): string {
  if (!clockFormatter) clockFormatter = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: BUSINESS_TIME_ZONE });
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return clockFormatter.format(d).replace(/\s*[ap]\.?m\.?$/i, "").trim();
}

/** "7.5 h", "8 h". */
export function clockedHoursLabel(hours: number): string {
  const r = Math.round(hours * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)} h`;
}

/** "7:42–3:10", "7:42 – on now", "7:42 – still on? (no clock-off)". */
export function spanTimes(span: Pick<ActualSpan, "startIso" | "endIso" | "open" | "stale">): string {
  if (span.stale) return `${clockTime(span.startIso)} – still on? (no clock-off)`;
  if (span.open) return `${clockTime(span.startIso)} – on now`;
  return `${clockTime(span.startIso)}–${clockTime(span.endIso)}`;
}

/** "Clocked 7:42–3:10" for one span, or "Clocked 7:00–9:00, 10:00–3:00" for several. */
export function actualLabel(spans: readonly Pick<ActualSpan, "startIso" | "endIso" | "open" | "stale">[]): string | null {
  if (spans.length === 0) return null;
  return `Clocked ${spans.map(spanTimes).join(", ")}`;
}

/** "Clocked 7:42–3:10 · 7.5 h" — the Week view's line under a booking, and the hover card's. */
export function actualLine(spans: readonly Pick<ActualSpan, "startIso" | "endIso" | "open" | "stale" | "hours">[]): string | null {
  const label = actualLabel(spans);
  if (!label) return null;
  return `${label} · ${clockedHoursLabel(spans.reduce((sum, s) => sum + s.hours, 0))}`;
}

// ---------------------------------------------------------------------------
// Day timeline geometry (units as lib/schedule-grid.ts: the phone's pt, the
// web's px)
// ---------------------------------------------------------------------------

/**
 * Where a clocked span's bar sits on the Day timeline: its real start and end,
 * clipped to the shown hours, at least 3 wide so a short span is still seen.
 * Null when it falls wholly outside the shown hours.
 */
export function actualBarGeometry(
  span: Pick<ActualSpan, "startIso" | "endIso" | "dateKey">,
  range: { startHour: number; endHour: number },
  hourWidth: number,
): { left: number; width: number } | null {
  const total = (range.endHour - range.startHour) * hourWidth;
  const toX = (iso: string) => (minutesIntoDay(iso, span.dateKey) / 60 - range.startHour) * hourWidth;
  const left = Math.max(0, toX(span.startIso));
  const right = Math.min(total, toX(span.endIso));
  if (right <= 0 || left >= total) return null;
  return { left: Math.min(left, total - 3), width: Math.max(3, right - left) };
}

/** The spans' days for widening the Day timeline (dayTimelineHours) to fit them. */
export function spanDays(spans: readonly Pick<ActualSpan, "dateKey" | "startIso" | "endIso">[]): { dateKey: string; startIso: string; endIso: string }[] {
  return spans.map((s) => ({ dateKey: s.dateKey, startIso: s.startIso, endIso: s.endIso }));
}

export type UnbookedPlacement = { span: ActualSpan; left: number; width: number; lane: number };

/**
 * Day view: a row's unbooked spans as blocks at their real times, packed into
 * their own lanes BELOW the row's bookings (the caller adds `lanes` lane
 * heights to the row).
 */
export function layoutUnbookedDay(
  spans: readonly ActualSpan[],
  range: { startHour: number; endHour: number },
  hourWidth: number,
): { items: UnbookedPlacement[]; lanes: number } {
  const geo = spans.map((span, i) => ({ id: `${span.entryId}:${i}`, span, ...dayBlockGeometry(span, range, hourWidth) }));
  const { lane, lanes } = packLanes(geo);
  return { items: geo.map((g) => ({ span: g.span, left: g.left, width: g.width, lane: lane.get(g.id) ?? 0 })), lanes };
}

/**
 * Week view: a row's unbooked spans as chips in their day's column, stacked in
 * lanes below the row's bookings (the caller adds `lanes` lane heights).
 */
export function layoutUnbookedWeek(
  dayKeys: readonly string[],
  spansFor: (dateKey: string) => readonly ActualSpan[],
  columnWidth: number,
): { items: UnbookedPlacement[]; lanes: number } {
  const items: UnbookedPlacement[] = [];
  let lanes = 0;
  dayKeys.forEach((key, col) => {
    const spans = spansFor(key);
    lanes = Math.max(lanes, spans.length);
    spans.forEach((span, i) => items.push({ span, left: col * columnWidth + 3, width: columnWidth - 6, lane: i }));
  });
  return { items, lanes };
}
