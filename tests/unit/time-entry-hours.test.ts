import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  plausibleClockedHours,
  checkManualClockedHours,
  MAX_PLAUSIBLE_WORK_HOURS,
} from "@/lib/time-entry-hours";

// The web clock-out did the raw subtraction and wrote the result straight to
// time_entries.hours, with no plausibility check — the same defect fixed in the
// mobile geofence, in two more places nobody had looked at.
//
// The scenario that makes this more than theoretical is CROSS-DEVICE. A
// technician clocks in on the mobile app whose device clock runs fast; the
// office clocks them out from the web with a correct clock. clock_out then
// precedes clock_in, the subtraction goes negative, and a negative number is
// written to the entry that feeds payroll. Nothing raises. It simply reconciles
// wrong at the next pay run.
//
// hours is nullable in production (verified against the live schema), so an
// implausible duration is recorded as null: the entry still closes, and the
// office sees a gap to correct rather than a figure that looks legitimate.

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-08-03T08:00:00.000Z");
const H = 3600000;

describe("plausibleClockedHours", () => {
  it("returns rounded hours for an ordinary shift", () => {
    expect(plausibleClockedHours(iso(T0), iso(T0 + 7.5 * H))).toBe(7.5);
  });

  it("rounds to two decimals, matching what the entry previously stored", () => {
    expect(plausibleClockedHours(iso(T0), iso(T0 + 1_000_000))).toBe(0.28);
  });

  // THE DEFECT. Cross-device clock skew, or a browser clock correcting itself.
  it("returns null when clock_out precedes clock_in", () => {
    expect(plausibleClockedHours(iso(T0), iso(T0 - H))).toBeNull();
  });

  it("returns null for a zero-length entry", () => {
    expect(plausibleClockedHours(iso(T0), iso(T0))).toBeNull();
  });

  it("returns null for a shift longer than a person plausibly works", () => {
    // An entry left open overnight, or over a weekend, then closed.
    expect(plausibleClockedHours(iso(T0), iso(T0 + 30 * H))).toBeNull();
  });

  it("accepts a long but real shift at the boundary", () => {
    expect(plausibleClockedHours(iso(T0), iso(T0 + MAX_PLAUSIBLE_WORK_HOURS * H))).toBe(
      MAX_PLAUSIBLE_WORK_HOURS
    );
  });

  it("returns null for an unparseable timestamp rather than NaN", () => {
    expect(plausibleClockedHours("not-a-date", iso(T0))).toBeNull();
    expect(plausibleClockedHours(iso(T0), "not-a-date")).toBeNull();
  });

  it("uses the same ceiling as the mobile auto-clock, so the platforms agree", () => {
    // mobile/lib/autoClockHours.ts uses 16. A technician clocking in on the
    // phone and out on the web must not get a different verdict on the same
    // duration.
    expect(MAX_PLAUSIBLE_WORK_HOURS).toBe(16);
  });
});

// The office edit dialog is the OTHER way hours reach payroll, and it was not
// covered by any of the above: components/job/time-entry-edit-dialog.tsx did the
// subtraction inline, twice, behind a `<= 0` guard with no ceiling. A mistyped
// year in the date field persisted a ~200-hour entry, which labour-billing-sync
// then priced onto the customer's bill. Migration 0051 would refuse it at the
// database, but 0051 is a DRAFT and is not applied.
//
// An automatic clock-out records null hours and moves on, because there is
// nobody at the keyboard to ask. A manual edit is different: someone IS at the
// keyboard, so an implausible pair is refused before it is written, and they get
// told which rule they broke.
describe("checkManualClockedHours", () => {
  const at = (ms: number) => new Date(ms);

  it("accepts an ordinary edited shift and reports the hours to persist", () => {
    expect(checkManualClockedHours(at(T0), at(T0 + 7.5 * H))).toEqual({ ok: true, hours: 7.5 });
  });

  // THE DEFECT. A year typed as 2025 instead of 2026, or a day instead of a
  // month, lands here — and used to save.
  it("refuses a 200-hour entry rather than persisting it", () => {
    const result = checkManualClockedHours(at(T0), at(T0 + 200 * H));
    expect(result.ok).toBe(false);
    // The office has to be told WHY, or the only feedback is a button that
    // will not click.
    if (!result.ok) expect(result.reason).toContain(String(MAX_PLAUSIBLE_WORK_HOURS));
  });

  it("agrees with the automatic clock-out at the boundary", () => {
    expect(checkManualClockedHours(at(T0), at(T0 + MAX_PLAUSIBLE_WORK_HOURS * H))).toEqual({
      ok: true,
      hours: MAX_PLAUSIBLE_WORK_HOURS,
    });
    expect(checkManualClockedHours(at(T0), at(T0 + (MAX_PLAUSIBLE_WORK_HOURS + 1) * H)).ok).toBe(false);
  });

  it("keeps the reversed-pair message the dialog already showed", () => {
    const result = checkManualClockedHours(at(T0), at(T0 - H));
    expect(result).toEqual({ ok: false, reason: "End time must be after start time" });
  });

  it("treats no end time as still clocked in — open entries are legitimate", () => {
    expect(checkManualClockedHours(at(T0), null)).toEqual({ ok: true, hours: null });
  });

  it("refuses a missing or unparseable start time", () => {
    expect(checkManualClockedHours(null, at(T0)).ok).toBe(false);
    expect(checkManualClockedHours(new Date("not-a-date"), at(T0)).ok).toBe(false);
    expect(checkManualClockedHours(at(T0), new Date("not-a-date")).ok).toBe(false);
  });
});

// HANDOVER-HARDENING.md:185 named this exact escape: "deleting the import at
// job-time.tsx:6 and inlining the old subtraction would keep the whole suite
// green". The dialog had already done it. Every behavioural test above passes
// against a screen that computes its own hours and never calls any of this.
//
// So the wiring is checked as well as the logic. lib/ is exempt — it is where
// the shared helper lives and does the arithmetic once.
describe("no screen computes clocked hours on its own", () => {
  const REPO = process.cwd();
  const ROOTS = ["app", "components"];
  const MS_PER_HOUR = /36e5|3_?600_?000/;

  function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
      }
    };
    for (const r of ROOTS) walk(join(REPO, r));
    return out;
  }

  it("routes duration maths through lib/time-entry-hours.ts", () => {
    const offenders = sourceFiles()
      .filter((f) => MS_PER_HOUR.test(readFileSync(f, "utf8")))
      .map((f) => relative(REPO, f));
    expect(offenders).toEqual([]);
  });
});
