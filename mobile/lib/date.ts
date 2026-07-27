// The business operates out of Melbourne, so all schedule/job times display in
// Australian Eastern time regardless of the device's own timezone — mirrors the
// web app's lib/date.ts so "today" and day-grouping match across web + mobile.
// (A device left on UTC, a CI/emulator, or a travelling user would otherwise
// bucket evening jobs onto the wrong calendar day.)
export const BUSINESS_TIME_ZONE = "Australia/Melbourne";

export function formatBusinessTime(value: string | Date): string {
  return new Date(value).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", timeZone: BUSINESS_TIME_ZONE });
}

// Stable "YYYY-MM-DD" key for an instant, as seen in Melbourne — use for
// grouping/comparing "today" instead of the device-local getters.
export function dateKeyInBusinessTZ(value: string | Date): string {
  return new Date(value).toLocaleDateString("en-CA", { timeZone: BUSINESS_TIME_ZONE }); // en-CA => YYYY-MM-DD
}

export function isTodayInBusinessTZ(value: string | Date): boolean {
  return dateKeyInBusinessTZ(value) === dateKeyInBusinessTZ(new Date());
}

// A human day header ("Wednesday, 22 July") in business time.
export function businessDayLabel(value: string | Date): string {
  return new Date(value).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", timeZone: BUSINESS_TIME_ZONE });
}

// Local calendar date as "YYYY-MM-DD" for a date the user picked in a date
// picker — they mean the local wall-clock date. `toISOString().slice(0,10)`
// would convert to UTC first and land a day early for AU (UTC+10/+11) users.
export function localDateKey(d: Date): string {
  return d.toLocaleDateString("en-CA"); // en-CA => YYYY-MM-DD, in the device's local TZ
}

// Hour-of-day (0-23) in business time — for the dashboard greeting.
export function businessHour(value: string | Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0");
}

// --- Schedule reschedule math (ported verbatim from the web lib/date.ts, which
// is DST-safe by looking the offset up in Melbourne explicitly rather than
// trusting the device TZ) ---

// A stored UTC instant → the "YYYY-MM-DDTHH:mm" Melbourne wall-clock string.
export function toBusinessInputValue(value: string | Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`;
}

function businessTimeZoneOffsetMinutes(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(instant);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour), Number(map.minute), Number(map.second));
  return (asUtc - instant.getTime()) / 60000;
}

// Reverse: a Melbourne wall-clock "YYYY-MM-DDTHH:mm" → the stored UTC ISO
// instant. Two-pass offset lookup so it's correct on either side of a DST edge.
export function fromBusinessInputValue(value: string): string {
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = businessTimeZoneOffsetMinutes(new Date(guess));
  return new Date(guess - offset * 60000).toISOString();
}

// Re-date an instant onto a different Melbourne calendar day, keeping its
// wall-clock time-of-day (a 9am job moved to Thursday stays a 9am job).
export function withDateKeyPreservingTime(value: string | Date, newDateKey: string): string {
  const [, timePart] = toBusinessInputValue(value).split("T");
  return fromBusinessInputValue(`${newDateKey}T${timePart}`);
}

// Move a scheduled job to a new day: start keeps its time-of-day; end keeps the
// original DURATION (so an overnight/multi-hour job stays the same length).
// Mirrors the web schedule board's drag-to-reschedule (team-schedule-view.tsx).
export function computeReschedule(
  startIso: string,
  endIso: string | null,
  newDateKey: string
): { scheduledStartIso: string; scheduledEndIso: string | null } {
  const scheduledStartIso = withDateKeyPreservingTime(startIso, newDateKey);
  const scheduledEndIso = endIso
    ? new Date(new Date(scheduledStartIso).getTime() + (new Date(endIso).getTime() - new Date(startIso).getTime())).toISOString()
    : null;
  return { scheduledStartIso, scheduledEndIso };
}
