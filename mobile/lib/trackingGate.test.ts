import {
  MAX_WAKE_REGIONS,
  WAKE_GRACE_MS,
  WAKE_REGION_RADIUS_M,
  WORK_HOURS,
  decideTracking,
  hasOpenWorkInOutbox,
  isDriveInProgress,
  isOnTheClock,
  isWithinWorkHours,
  trackingSettings,
  wakeRegions,
  type ClockSignals,
  type TrackingInputs,
} from "./trackingGate";
import type { Operation, WriteOperation } from "./data/outbox/types";

// The gate decides when GPS runs at all. Its failure mode in one direction is a
// flat battery; in the other it is a technician's hours silently not recorded.
// The cases below pin the second direction hardest: on the clock beats the time
// of day, and every "cannot tell" resolves to tracking.

// Local-time constructors — the gate reads device-local hours and weekdays.
// 2026-10-05 is a Monday; 2026-10-11 a Sunday.
const mon = (h: number, m = 0) => new Date(2026, 9, 5, h, m);
const sat = (h: number, m = 0) => new Date(2026, 9, 10, h, m);
const sun = (h: number, m = 0) => new Date(2026, 9, 11, h, m);

function inputs(over: Partial<TrackingInputs> = {}): TrackingInputs {
  return { userId: "tech-1", role: "technician", siteCount: 2, onTheClock: false, now: mon(10), ...over };
}

describe("isWithinWorkHours (default 06:00–19:00, Mon–Sat)", () => {
  it("is open from 06:00 up to but not including 19:00 on a weekday", () => {
    expect(isWithinWorkHours(mon(5, 59))).toBe(false);
    expect(isWithinWorkHours(mon(6, 0))).toBe(true);
    expect(isWithinWorkHours(mon(18, 59))).toBe(true);
    expect(isWithinWorkHours(mon(19, 0))).toBe(false);
  });

  it("includes Saturday and excludes Sunday", () => {
    expect(isWithinWorkHours(sat(9))).toBe(true);
    expect(isWithinWorkHours(sun(9))).toBe(false);
  });

  it("takes its window from one constant, and honours an override", () => {
    expect(WORK_HOURS).toEqual({ startHour: 6, endHour: 19, days: [1, 2, 3, 4, 5, 6] });
    expect(isWithinWorkHours(sun(9), { startHour: 8, endHour: 12, days: [0] })).toBe(true);
  });
});

describe("decideTracking", () => {
  it("tracks a technician with sites inside work hours, in watching mode", () => {
    expect(decideTracking(inputs())).toEqual({ track: true, mode: "watching" });
  });

  it("stops when signed out", () => {
    expect(decideTracking(inputs({ userId: null }))).toEqual({ track: false, reason: "signed-out" });
  });

  it("stops for office and admin, even on the clock", () => {
    for (const role of ["office", "admin"]) {
      expect(decideTracking(inputs({ role, onTheClock: true }))).toEqual({ track: false, reason: "not-technician" });
    }
  });

  it("does NOT stop for an unknown role — a technician whose profile has not loaded (offline launch)", () => {
    expect(decideTracking(inputs({ role: null })).track).toBe(true);
    expect(decideTracking(inputs({ role: undefined })).track).toBe(true);
  });

  it("stops with no geofence-able site, since no reading could record anything", () => {
    expect(decideTracking(inputs({ siteCount: 0 }))).toEqual({ track: false, reason: "no-sites" });
    expect(decideTracking(inputs({ siteCount: 0, onTheClock: true }))).toEqual({ track: false, reason: "no-sites" });
  });

  it("stops outside work hours when not on the clock", () => {
    expect(decideTracking(inputs({ now: mon(19, 0) }))).toEqual({ track: false, reason: "off-hours" });
    expect(decideTracking(inputs({ now: mon(5) }))).toEqual({ track: false, reason: "off-hours" });
    expect(decideTracking(inputs({ now: sun(10) }))).toEqual({ track: false, reason: "off-hours" });
  });

  // THE PAYROLL RULE.
  it("keeps tracking a technician on the clock regardless of the hour or day", () => {
    for (const now of [mon(10), mon(19, 0), mon(23, 30), mon(3), sun(10)]) {
      expect(decideTracking(inputs({ onTheClock: true, now }))).toEqual({ track: true, mode: "on-the-clock" });
    }
  });
});

describe("isOnTheClock", () => {
  const NOW = mon(20).getTime();
  const base: ClockSignals = {
    openWorkEntry: null,
    openWorkInOutbox: false,
    insideJobId: null,
    pendingDeparture: null,
    siteWakeAt: null,
    nowMs: NOW,
  };
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const H = 60 * 60 * 1000;

  it("is false only when every signal is clear", () => {
    expect(isOnTheClock(base)).toBe(false);
  });

  it("is true for an open work entry in the mirror", () => {
    expect(isOnTheClock({ ...base, openWorkEntry: { clockInIso: iso(2 * H) } })).toBe(true);
  });

  it("is true when the mirror could not answer — unsure resolves to tracking", () => {
    expect(isOnTheClock({ ...base, openWorkEntry: "unknown" })).toBe(true);
  });

  it("ignores an entry open past the work ceiling — a forgotten clock-out must not hold GPS on for days", () => {
    expect(isOnTheClock({ ...base, openWorkEntry: { clockInIso: iso(17 * H) } })).toBe(false);
    // Negative control: a long but believable stint still counts.
    expect(isOnTheClock({ ...base, openWorkEntry: { clockInIso: iso(15 * H) } })).toBe(true);
  });

  it("counts an entry stamped in the future (clock moved backwards) or unparseable as open", () => {
    expect(isOnTheClock({ ...base, openWorkEntry: { clockInIso: iso(-H) } })).toBe(true);
    expect(isOnTheClock({ ...base, openWorkEntry: { clockInIso: "not a date" } })).toBe(true);
  });

  it("is true for an offline clock-in still in the outbox — the mirror lags it", () => {
    expect(isOnTheClock({ ...base, openWorkInOutbox: true })).toBe(true);
  });

  it("is true while the geofence has us inside a site", () => {
    expect(isOnTheClock({ ...base, insideJobId: "job-a" })).toBe(true);
  });

  it("is true BETWEEN sites while a drive is in progress — the travel leg is the point", () => {
    expect(isOnTheClock({ ...base, pendingDeparture: { jobId: "job-a", at: iso(20 * 60 * 1000) } })).toBe(true);
  });
});

describe("isOnTheClock — off-hours site wake", () => {
  const NOW = mon(22).getTime();
  const signals = (siteWakeAt: string | null): ClockSignals => ({
    openWorkEntry: null,
    openWorkInOutbox: false,
    insideJobId: null,
    pendingDeparture: null,
    siteWakeAt,
    nowMs: NOW,
  });

  it("holds for the wake grace window, so the arrival can be read before anything stops tracking", () => {
    expect(isOnTheClock(signals(new Date(NOW - 19 * 60_000).toISOString()))).toBe(true);
    expect(isOnTheClock(signals(new Date(NOW - WAKE_GRACE_MS).toISOString()))).toBe(false);
    expect(isOnTheClock(signals(null))).toBe(false);
  });
});

describe("wakeRegions", () => {
  const site = (n: number) => ({ jobId: `j${n}`, lat: -37 - n / 100, lng: 145, scheduledCostCenterId: null });

  it("is wider than the 150 m geofence, enter-only, keyed by job", () => {
    expect(wakeRegions([site(1)])).toEqual([
      { identifier: "j1", latitude: -37.01, longitude: 145, radius: WAKE_REGION_RADIUS_M, notifyOnEnter: true, notifyOnExit: false },
    ]);
    expect(WAKE_REGION_RADIUS_M).toBeGreaterThan(150);
  });

  it("keeps the first 20 in the order given (soonest first) — the iOS per-app cap", () => {
    const regions = wakeRegions(Array.from({ length: 25 }, (_, i) => site(i)));
    expect(regions).toHaveLength(MAX_WAKE_REGIONS);
    expect(MAX_WAKE_REGIONS).toBe(20);
    expect(regions[0].identifier).toBe("j0");
    expect(regions[19].identifier).toBe("j19");
  });
});

describe("isDriveInProgress", () => {
  const NOW = mon(20).getTime();
  const H = 60 * 60 * 1000;

  it("holds for as long as the leg could still be believed (3h travel ceiling)", () => {
    expect(isDriveInProgress({ jobId: "a", at: new Date(NOW - 2.9 * H).toISOString() }, NOW)).toBe(true);
    expect(isDriveInProgress({ jobId: "a", at: new Date(NOW - 3 * H).toISOString() }, NOW)).toBe(false);
  });

  it("errs toward tracking when the departure is stamped in the future", () => {
    expect(isDriveInProgress({ jobId: "a", at: new Date(NOW + H).toISOString() }, NOW)).toBe(true);
  });

  it("is false with no departure or a corrupt one", () => {
    expect(isDriveInProgress(null, NOW)).toBe(false);
    expect(isDriveInProgress({ jobId: "a", at: "garbage" }, NOW)).toBe(false);
  });
});

describe("hasOpenWorkInOutbox", () => {
  let n = 0;
  function write(over: Partial<WriteOperation> & Pick<WriteOperation, "op" | "rowId" | "payload">): WriteOperation {
    return {
      kind: "write",
      id: `op-${++n}`,
      aggregate: "time_entry",
      table: "time_entries",
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: 0,
      ...over,
    };
  }
  const clockIn = (rowId: string, over: Partial<WriteOperation> = {}, payload: Record<string, unknown> = {}) =>
    write({ op: "insert", rowId, payload: { staff_id: "tech-1", job_id: "j", clock_in: "2026-10-05T08:00:00Z", ...payload }, ...over });

  it("finds a queued clock-in for this technician", () => {
    expect(hasOpenWorkInOutbox([clockIn("e1")], "tech-1")).toBe(true);
    expect(hasOpenWorkInOutbox([clockIn("e1", { status: "inflight" })], "tech-1")).toBe(true);
    expect(hasOpenWorkInOutbox([clockIn("e1", { status: "failed" })], "tech-1")).toBe(true);
  });

  it("ignores another technician's, a delivered one, and a dead one", () => {
    expect(hasOpenWorkInOutbox([clockIn("e1")], "tech-2")).toBe(false);
    expect(hasOpenWorkInOutbox([clockIn("e1", { status: "done" })], "tech-1")).toBe(false);
    expect(hasOpenWorkInOutbox([clockIn("e1", { status: "dead" })], "tech-1")).toBe(false);
  });

  it("ignores a closed manual entry and a travel leg", () => {
    expect(hasOpenWorkInOutbox([clockIn("e1", {}, { clock_out: "2026-10-05T09:00:00Z" })], "tech-1")).toBe(false);
    expect(hasOpenWorkInOutbox([clockIn("e1", {}, { entry_type: "travel" })], "tech-1")).toBe(false);
  });

  it("treats a queued clock-out or delete of the same row as closing it", () => {
    const out = write({ op: "update", rowId: "e1", payload: { clock_out: "2026-10-05T09:00:00Z", hours: 1 } });
    expect(hasOpenWorkInOutbox([clockIn("e1"), out], "tech-1")).toBe(false);
    expect(hasOpenWorkInOutbox([clockIn("e1"), write({ op: "delete", rowId: "e1", payload: {} })], "tech-1")).toBe(false);
    // An update that does NOT close it (stage reassignment) leaves it open.
    expect(
      hasOpenWorkInOutbox([clockIn("e1"), write({ op: "update", rowId: "e1", payload: { cost_center_id: "cc" } })], "tech-1")
    ).toBe(true);
  });

  it("ignores side effects and other tables", () => {
    const side = { kind: "side_effect", id: "s", effect: "sync-billing", status: "pending" } as unknown as Operation;
    const other = write({ op: "insert", rowId: "n1", table: "job_notes", aggregate: "job_note", payload: { staff_id: "tech-1" } });
    expect(hasOpenWorkInOutbox([side, other], "tech-1")).toBe(false);
  });
});

describe("trackingSettings", () => {
  it("never lowers accuracy below balanced, and never lets iOS pause updates", () => {
    for (const [mode, onSite] of [
      ["watching", false],
      ["on-the-clock", false],
      ["on-the-clock", true],
    ] as const) {
      const s = trackingSettings(mode, onSite);
      expect(s.accuracy).toBe("balanced");
      expect(s.pausesUpdatesAutomatically).toBe(false);
      // Deferral never waits on distance: a held arrival is lost if tracking stops.
      expect(s.deferredUpdatesDistanceM).toBe(0);
    }
  });

  it("keeps the pre-gate profile while on the clock between sites — departure and arrival times are payroll", () => {
    expect(trackingSettings("on-the-clock", false)).toEqual({
      accuracy: "balanced",
      timeIntervalMs: 15_000,
      distanceIntervalM: 25,
      deferredUpdatesIntervalMs: 0,
      deferredUpdatesDistanceM: 0,
      activityType: "automotiveNavigation",
      pausesUpdatesAutomatically: false,
    });
  });

  it("batches background wake-ups only while on site", () => {
    expect(trackingSettings("on-the-clock", true).deferredUpdatesIntervalMs).toBe(60_000);
    expect(trackingSettings("on-the-clock", true).timeIntervalMs).toBe(15_000);
  });

  it("watches for an arrival at half the cadence, with no deferral and the same distance filter", () => {
    const s = trackingSettings("watching", false);
    expect(s.timeIntervalMs).toBe(30_000);
    expect(s.distanceIntervalM).toBe(25);
    expect(s.deferredUpdatesIntervalMs).toBe(0);
    expect(s.activityType).toBe("other");
  });
});
