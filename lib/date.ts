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
