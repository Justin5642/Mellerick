import { shiftDateKey } from "./date";
import { businessDayRange, type ScheduledJobWindow } from "./scheduling";
import { scheduleDayOn } from "./scheduleDisplay";

// The office dashboard's two web tiles on the phone (19 Nov 2026), with the
// web's rules (app/dashboard/page.tsx):
//
// "Needs a look from yesterday" (Stage 5, 31 Oct 2026)
//   • jobs booked YESTERDAY (Melbourne) that nobody signed off — still open —
//     and not simply carrying on today (a Mon–Wed job is not "unfinished" on
//     Tuesday morning);
//   • clocks still running (open WORK entries) that started before today —
//     the departures the phone missed.
// "Variations to invoice"
//   • approved / auto-approved variations not on an invoice yet; count and
//     total. The permanent QA fixture job's probe variation is left out, as
//     on the web.

/** Open jobs booked yesterday and not today. `jobs` = open scheduled jobs (completed/cancelled already excluded). */
export function unfinishedYesterday<T extends ScheduledJobWindow>(jobs: readonly T[], todayKey: string): T[] {
  const yesterdayKey = shiftDateKey(todayKey, -1);
  return jobs.filter((job) => scheduleDayOn(job, yesterdayKey) !== null && scheduleDayOn(job, todayKey) === null);
}

/** Open clocks that started before today's Melbourne midnight, oldest first. */
export function clocksFromBeforeToday<T extends { clock_in: string }>(clocks: readonly T[], todayKey: string): T[] {
  const todayStart = new Date(businessDayRange(todayKey).dayStartIso).getTime();
  return clocks
    .filter((c) => {
      const t = new Date(c.clock_in).getTime();
      return Number.isFinite(t) && t < todayStart;
    })
    .sort((a, b) => new Date(a.clock_in).getTime() - new Date(b.clock_in).getTime());
}

export interface UnbilledVariationLike {
  total_amount: number | null;
  jobs: { title: string | null } | null;
}

/** How many approved variations wait to be invoiced, and their total (office only — shown via MoneyText). */
export function variationsToInvoice(variations: readonly UnbilledVariationLike[]): { count: number; total: number } {
  const real = variations.filter((v) => !v.jobs?.title?.startsWith("QA FIXTURE"));
  return { count: real.length, total: real.reduce((sum, v) => sum + Number(v.total_amount ?? 0), 0) };
}
