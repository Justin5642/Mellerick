// The business operates out of Melbourne, so all schedule/job times should
// be displayed in Australian Eastern time regardless of where the server
// (Vercel, UTC) or a staff member's device happens to be set. Without this,
// timestamps rendered on the server drift by 10-11 hours from what the team
// actually sees on the clock.
export const BUSINESS_TIME_ZONE = "Australia/Melbourne";

export function formatTime(value: string | Date) {
  return new Date(value).toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: BUSINESS_TIME_ZONE,
  });
}

export function formatDate(
  value: string | Date,
  opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }
) {
  return new Date(value).toLocaleDateString("en-AU", { ...opts, timeZone: BUSINESS_TIME_ZONE });
}

// A stable "YYYY-MM-DD" key for the given instant, as seen in Melbourne —
// use this instead of `Date#toDateString()` when grouping/comparing "today".
export function dateKeyInBusinessTZ(value: string | Date) {
  return new Date(value).toLocaleDateString("en-CA", { timeZone: BUSINESS_TIME_ZONE }); // en-CA => YYYY-MM-DD
}

export function isTodayInBusinessTZ(value: string | Date) {
  return dateKeyInBusinessTZ(value) === dateKeyInBusinessTZ(new Date());
}

// Year/month/day/hour for the given instant as seen in Melbourne — use this
// instead of Date#getFullYear()/getMonth()/getHours() when bucketing by
// month or branching on time-of-day, since those getters read the server's
// local clock (UTC on Vercel), not the business's.
export function formatDateTime(value: string | Date) {
  return new Date(value).toLocaleString("en-AU", { timeZone: BUSINESS_TIME_ZONE });
}

// datetime-local inputs read/write local wall-clock digits with no
// timezone information at all, so converting between a stored UTC instant
// and the string an <input type="datetime-local"> expects must go through
// the business timezone explicitly. Relying on the browser/device's own
// local timezone would silently produce the wrong value for anyone whose
// device isn't set to Melbourne (or for any server-rendered value), and
// mixing UTC digits into a field that's supposed to hold local digits is
// exactly what caused scheduled jobs to land on the wrong calendar day.
export function toBusinessInputValue(value: string | Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`;
}

function businessTimeZoneOffsetMinutes(instant: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return (asUtc - instant.getTime()) / 60000;
}

// Reverse of toBusinessInputValue: given a "YYYY-MM-DDTHH:mm" string that
// represents a Melbourne wall-clock time (exactly what a datetime-local
// input produces), return the matching instant as a UTC ISO string to
// store. Two-pass offset lookup so it's correct on either side of a DST
// transition, not just a fixed +10/+11.
export function fromBusinessInputValue(value: string) {
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = businessTimeZoneOffsetMinutes(new Date(guess));
  return new Date(guess - offset * 60000).toISOString();
}

// Re-dates an instant onto a different Melbourne calendar day while keeping
// its wall-clock time-of-day unchanged (e.g. a 9:00am job dragged from
// Tuesday to Thursday stays a 9:00am job) — used by the schedule board's
// week-view drag-and-drop, where dropping a job on a different day column
// needs to move the date without touching the time.
export function withDateKeyPreservingTime(value: string | Date, newDateKey: string): string {
  const [, timePart] = toBusinessInputValue(value).split("T");
  return fromBusinessInputValue(`${newDateKey}T${timePart}`);
}

// A stable "N days forward/back" step that stays on the same Melbourne
// calendar date regardless of DST — anchoring at UTC noon means the
// Melbourne-local clock is always somewhere between 22:00-23:00 the same
// day (offset is always +10 or +11), so it never rolls over a date line.
export function shiftDateKey(key: string, days: number) {
  const [y, m, d] = key.split("-").map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return dateKeyInBusinessTZ(anchor);
}

// A UTC-noon-anchored Date for a "YYYY-MM-DD" key, safe to pass into
// formatDate/formatTime without drifting across a date line in either
// direction (see shiftDateKey above for why noon).
export function anchorForDateKey(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

// Monday of the week containing `key` (AU/ISO convention), as a
// "YYYY-MM-DD" key.
export function startOfWeekKey(key: string) {
  const anchor = anchorForDateKey(key);
  const dow = anchor.getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  anchor.setUTCDate(anchor.getUTCDate() + diffToMonday);
  return dateKeyInBusinessTZ(anchor);
}

// The 7 consecutive "YYYY-MM-DD" keys (Mon-Sun) for the week containing
// `key`.
export function weekDateKeys(key: string) {
  const start = startOfWeekKey(key);
  return Array.from({ length: 7 }, (_, i) => shiftDateKey(start, i));
}

export function businessDateParts(value: string | Date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
  };
}
