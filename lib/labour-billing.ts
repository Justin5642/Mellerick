// Splits a logged time entry (clock_in -> clock_out) into ordinary / time-
// and-a-half / double-time hours based on Melbourne wall-clock time, then
// prices those hours out for either a qualified tradesperson (flat rate) or
// an apprentice (their own loaded cost rate + margin). This is the shared
// engine behind the job's auto-generated labour line item -- see
// components/job/job-line-items.tsx and the time-entry insert/update paths
// that call into it. Kept in one place, independent of any UI, so the web
// dashboard, the mobile app's server-side sync, and any future reporting
// all price a given shift identically.
//
// Band rules (confirmed with the business, 2026-07):
//   Mon-Fri  00:00-05:00  double time
//   Mon-Fri  05:00-07:00  time and a half
//   Mon-Fri  07:00-17:00  ordinary hours
//   Mon-Fri  17:00-19:00  time and a half
//   Mon-Fri  19:00-24:00  double time
//   Sat/Sun  00:00-24:00  double time (no time-and-a-half tier)
//
// The 2-hour time-and-a-half window on each side of ordinary hours is a
// default assumption (common trade-award pattern: first 2hrs of overtime at
// 1.5x, then 2x) -- adjust ORDINARY_START_HOUR/ORDINARY_END_HOUR/
// OVERTIME_STEP_HOURS below if the business's actual figure differs.

import { dateKeyInBusinessTZ, fromBusinessInputValue, shiftDateKey, anchorForDateKey } from "./date";

const ORDINARY_START_HOUR = 7;
const ORDINARY_END_HOUR = 17;
const OVERTIME_STEP_HOURS = 2; // width of the time-and-a-half band on each side of ordinary hours

export type RateBand = "normal" | "time_and_half" | "double_time";

export interface HourBreakdown {
  normalHours: number;
  timeAndHalfHours: number;
  doubleTimeHours: number;
  totalHours: number;
}

const EMPTY_BREAKDOWN: HourBreakdown = { normalHours: 0, timeAndHalfHours: 0, doubleTimeHours: 0, totalHours: 0 };

function pad(n: number) {
  return String(n).padStart(2, "0");
}

// Melbourne-local day-of-week for a "YYYY-MM-DD" key (0 = Sunday ... 6 =
// Saturday) -- reuses the same UTC-noon-anchor trick as lib/date.ts's
// startOfWeekKey, since the key itself is already a Melbourne calendar date.
function isWeekend(dateKey: string) {
  const dow = anchorForDateKey(dateKey).getUTCDay();
  return dow === 0 || dow === 6;
}

// The ordered list of (instant, band-that-starts-here) boundaries for one
// Melbourne calendar day, as UTC instants (ms since epoch).
function dayBoundaries(dateKey: string): { at: number; band: RateBand }[] {
  const at = (hour: number) => new Date(fromBusinessInputValue(`${dateKey}T${pad(hour)}:00`)).getTime();
  if (isWeekend(dateKey)) {
    return [{ at: at(0), band: "double_time" }];
  }
  return [
    { at: at(0), band: "double_time" },
    { at: at(ORDINARY_START_HOUR - OVERTIME_STEP_HOURS), band: "time_and_half" },
    { at: at(ORDINARY_START_HOUR), band: "normal" },
    { at: at(ORDINARY_END_HOUR), band: "time_and_half" },
    { at: at(ORDINARY_END_HOUR + OVERTIME_STEP_HOURS), band: "double_time" },
  ];
}

// Splits [startMs, endMs) into per-band millisecond totals by walking each
// Melbourne calendar day the shift touches and intersecting it against that
// day's boundaries. Handles shifts that cross midnight, cross a weekday/
// weekend boundary, or cross a DST transition (fromBusinessInputValue
// already resolves each boundary's correct UTC offset independently).
export function splitHoursByBand(clockIn: string | Date, clockOut: string | Date): HourBreakdown {
  const startMs = new Date(clockIn).getTime();
  const endMs = new Date(clockOut).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return { ...EMPTY_BREAKDOWN };

  const msByBand: Record<RateBand, number> = { normal: 0, time_and_half: 0, double_time: 0 };

  let dateKey = dateKeyInBusinessTZ(new Date(startMs));
  const lastDateKey = dateKeyInBusinessTZ(new Date(endMs));
  // Safety cap -- a logged shift spanning >30 days would indicate corrupt
  // data, not a real time entry; avoids an unbounded loop on bad input.
  for (let guard = 0; guard < 32; guard++) {
    const boundaries = dayBoundaries(dateKey);
    const nextDateKey = shiftDateKey(dateKey, 1);
    const dayEndMs = new Date(fromBusinessInputValue(`${nextDateKey}T00:00`)).getTime();

    for (let i = 0; i < boundaries.length; i++) {
      const segStart = boundaries[i].at;
      const segEnd = i + 1 < boundaries.length ? boundaries[i + 1].at : dayEndMs;
      const overlapStart = Math.max(startMs, segStart);
      const overlapEnd = Math.min(endMs, segEnd);
      if (overlapEnd > overlapStart) {
        msByBand[boundaries[i].band] += overlapEnd - overlapStart;
      }
    }

    if (dateKey === lastDateKey || dayEndMs >= endMs) break;
    dateKey = nextDateKey;
  }

  const normalHours = msByBand.normal / 3_600_000;
  const timeAndHalfHours = msByBand.time_and_half / 3_600_000;
  const doubleTimeHours = msByBand.double_time / 3_600_000;
  return {
    normalHours,
    timeAndHalfHours,
    doubleTimeHours,
    totalHours: normalHours + timeAndHalfHours + doubleTimeHours,
  };
}

export interface LabourRateConfig {
  qualifiedBaseRate: number; // $/hr ordinary rate for a qualified tradesperson, e.g. 130
  apprenticeMarginPct: number; // e.g. 30 -> apprentice bills at 1.3x their loaded cost rate
  timeAndHalfMultiplier: number; // e.g. 1.5
  doubleTimeMultiplier: number; // e.g. 2
}

export const DEFAULT_LABOUR_RATE_CONFIG: LabourRateConfig = {
  qualifiedBaseRate: 130,
  apprenticeMarginPct: 30,
  timeAndHalfMultiplier: 1.5,
  doubleTimeMultiplier: 2,
};

export interface LabourChargeInputs {
  tradeLevel: "qualified" | "apprentice";
  breakdown: HourBreakdown;
  rateConfig: LabourRateConfig;
  // Required when tradeLevel === "apprentice" -- their own fully-loaded
  // hourly cost (lib/staff-cost.ts's computeLoadedCost().loadedHourlyRate).
  // Ignored for qualified tradespeople, who bill at the flat base rate
  // regardless of what they individually cost.
  loadedHourlyCost?: number;
}

export interface LabourChargeResult {
  ordinaryHourlyRate: number;
  timeAndHalfHourlyRate: number;
  doubleTimeHourlyRate: number;
  normalCharge: number;
  timeAndHalfCharge: number;
  doubleTimeCharge: number;
  totalCharge: number;
}

// Prices a shift's hour breakdown out to a dollar figure. A qualified
// tradesperson bills at a flat rate (same $ regardless of who's actually on
// the tools) with the two overtime multipliers stacked on top; an
// apprentice bills at their own loaded cost rate plus the configured margin,
// with the same overtime multipliers stacked on top of THAT marked-up rate
// (mirrors how the business already treats qualified overtime -- overtime
// is a multiplier on the normal bill rate, not a separate flat number).
export function computeLabourCharge({ tradeLevel, breakdown, rateConfig, loadedHourlyCost }: LabourChargeInputs): LabourChargeResult {
  const ordinaryHourlyRate =
    tradeLevel === "qualified"
      ? rateConfig.qualifiedBaseRate
      : Number(loadedHourlyCost || 0) * (1 + rateConfig.apprenticeMarginPct / 100);

  const timeAndHalfHourlyRate = ordinaryHourlyRate * rateConfig.timeAndHalfMultiplier;
  const doubleTimeHourlyRate = ordinaryHourlyRate * rateConfig.doubleTimeMultiplier;

  const normalCharge = breakdown.normalHours * ordinaryHourlyRate;
  const timeAndHalfCharge = breakdown.timeAndHalfHours * timeAndHalfHourlyRate;
  const doubleTimeCharge = breakdown.doubleTimeHours * doubleTimeHourlyRate;

  return {
    ordinaryHourlyRate,
    timeAndHalfHourlyRate,
    doubleTimeHourlyRate,
    normalCharge,
    timeAndHalfCharge,
    doubleTimeCharge,
    totalCharge: normalCharge + timeAndHalfCharge + doubleTimeCharge,
  };
}
