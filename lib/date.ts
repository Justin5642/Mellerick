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
