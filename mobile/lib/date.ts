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

// Hour-of-day (0-23) in business time — for the dashboard greeting.
export function businessHour(value: string | Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0");
}
