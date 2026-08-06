import { planBackgroundClockActions } from "./backgroundClockPlan";
import type { TrackedSite } from "./geofenceState";

// The background auto-clock, as a pure plan.
//
// WHY THIS EXISTS AT ALL. The geofence auto-clock has only ever run in the
// FOREGROUND, via expo-location's watchPositionAsync. The moment a technician
// puts the phone in their pocket and drives to the next site, tracking stops —
// so the travel leg is never recorded, and the arrival at the next site is only
// noticed when they next open the app. Nothing errors. Nothing is logged. The
// hours simply do not appear, and the technician is paid less than they worked.
// A payroll feature that under-records in silence is worse than one that is
// obviously missing, because nobody thinks to check it.
//
// The background task receives a BATCH of locations, has no React tree, and may
// be killed between invocations — so the decision must be a pure function of
// (batch, sites, previously-persisted state). That is what this is.

const SITE_A: TrackedSite = { jobId: "job-a", lat: -37.8136, lng: 144.9631 };
const SITE_B: TrackedSite = { jobId: "job-b", lat: -37.9136, lng: 144.9631 };

const at = (site: TrackedSite, ms: number) => ({
  coords: { latitude: site.lat, longitude: site.lng },
  timestamp: ms,
});
const away = (ms: number) => ({ coords: { latitude: -37.0, longitude: 144.0 }, timestamp: ms });

const T0 = Date.parse("2026-08-04T08:00:00.000Z");
const MIN = 60_000;

describe("planBackgroundClockActions", () => {
  it("plans an arrival when the batch enters a site", () => {
    const { actions, insideJobId } = planBackgroundClockActions([at(SITE_A, T0)], [SITE_A], null);
    expect(insideJobId).toBe("job-a");
    expect(actions).toEqual([{ type: "arrive", jobId: "job-a", at: new Date(T0).toISOString(), fromJobId: null, fromAt: null }]);
  });

  // THE CASE THAT JUSTIFIES PROCESSING THE WHOLE BATCH.
  //
  // Background location is delivered in batches — the OS buffers readings and
  // hands over several at once. Looking only at the newest would collapse a
  // whole arrive-work-depart cycle into a single "where are you now", losing
  // the entire visit. That is precisely the silent under-recording this exists
  // to fix, so it gets a test rather than a comment.
  it("plans BOTH actions when one batch contains an arrival and a departure", () => {
    const batch = [away(T0), at(SITE_A, T0 + MIN), away(T0 + 90 * MIN)];
    const { actions, insideJobId } = planBackgroundClockActions(batch, [SITE_A], null);
    expect(actions.map((a) => a.type)).toEqual(["arrive", "depart"]);
    expect(insideJobId).toBeNull();
  });

  it("carries the previous site forward so a travel leg can be attributed", () => {
    // Driving A -> B. The arrival at B must know it came from A, or the travel
    // time between them is unattributable and gets dropped.
    const { actions } = planBackgroundClockActions([at(SITE_B, T0)], [SITE_A, SITE_B], "job-a");
    expect(actions).toEqual([
      { type: "depart", jobId: "job-a", at: new Date(T0).toISOString(), fromJobId: null, fromAt: null },
      { type: "arrive", jobId: "job-b", at: new Date(T0).toISOString(), fromJobId: "job-a", fromAt: new Date(T0).toISOString() },
    ]);
  });

  it("plans nothing when the batch never crosses a boundary", () => {
    const batch = [at(SITE_A, T0), at(SITE_A, T0 + MIN), at(SITE_A, T0 + 2 * MIN)];
    const { actions, insideJobId } = planBackgroundClockActions(batch, [SITE_A], "job-a");
    expect(actions).toEqual([]);
    expect(insideJobId).toBe("job-a");
  });

  it("processes the batch in TIME order, not delivery order", () => {
    // The OS does not guarantee ordering. Out-of-order readings would otherwise
    // manufacture a depart-then-arrive from a simple arrival.
    const batch = [at(SITE_A, T0 + 2 * MIN), away(T0), at(SITE_A, T0 + MIN)];
    const { actions, insideJobId } = planBackgroundClockActions(batch, [SITE_A], null);
    expect(actions.map((a) => a.type)).toEqual(["arrive"]);
    expect(insideJobId).toBe("job-a");
  });

  it("plans nothing when sites are not loaded — absence of data is not a departure", () => {
    // Clocking someone OUT because their job list failed to load would fabricate
    // a time entry, and the geofence state must survive it unchanged.
    const { actions, insideJobId } = planBackgroundClockActions([at(SITE_A, T0)], [], "job-a");
    expect(actions).toEqual([]);
    expect(insideJobId).toBe("job-a");
  });

  it("tolerates an empty batch", () => {
    const { actions, insideJobId } = planBackgroundClockActions([], [SITE_A], "job-a");
    expect(actions).toEqual([]);
    expect(insideJobId).toBe("job-a");
  });

  it("uses each reading's OWN timestamp, not the time the batch was processed", () => {
    // A batch may be delivered long after the events in it. Stamping every
    // action with "now" would compress a two-hour visit into a single instant
    // and silently destroy the hours it represents.
    const batch = [at(SITE_A, T0), away(T0 + 120 * MIN)];
    const { actions } = planBackgroundClockActions(batch, [SITE_A], null);
    expect(actions[0].at).toBe(new Date(T0).toISOString());
    expect(actions[1].at).toBe(new Date(T0 + 120 * MIN).toISOString());
  });

  it("ignores readings with no usable timestamp rather than stamping them now", () => {
    const batch = [{ coords: { latitude: SITE_A.lat, longitude: SITE_A.lng }, timestamp: NaN }];
    expect(planBackgroundClockActions(batch, [SITE_A], null).actions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TRAVEL LEGS — the feature this module exists to deliver, and which it could
// not produce at all.
//
// Two independent causes, both structural:
//
//   (a) fromJobId came from state.previousJobId, which nextGeofenceState only
//       populates when ONE reading moves from inside site A to inside site B.
//       Real driving — 15s/25m sampling, sites hundreds of metres apart — always
//       produces readings outside both first. That emits a departure with
//       insideJobId null, so the later arrival carried fromJobId null and the
//       caller's `if (fromJobId)` never fired.
//
//   (b) In the one case it WAS populated (the teleport), depart and arrive were
//       stamped from the same reading, so the computed duration was zero and the
//       leg was discarded as implausible.
//
// Zero travel legs on both paths — while backgroundClockTask.ts:18-22 asserts
// "the two paths produce the SAME rows … Divergence here would be invisible and
// would show up only as a disputed payslip". The foreground watcher gets this
// right by carrying departureRef ACROSS readings; the plan had no equivalent,
// and none across invocations either.
//
// The pre-existing test for this asserted only the teleport case — the one that
// can never yield hours — so it passed while the feature did nothing.
// ---------------------------------------------------------------------------
describe("planBackgroundClockActions — travel legs", () => {
  it("attributes a leg across the away-readings of a real drive", () => {
    // A -> away -> away -> B. The case that happens every time and could never
    // produce a leg.
    const batch = [at(SITE_A, T0), away(T0 + MIN), away(T0 + 2 * MIN), at(SITE_B, T0 + 20 * MIN)];
    const { actions } = planBackgroundClockActions(batch, [SITE_A, SITE_B], "job-a");

    const arrival = actions.find((a) => a.type === "arrive" && a.jobId === "job-b");
    expect(arrival).toBeDefined();
    expect(arrival!.fromJobId).toBe("job-a");
    // Timed from the DEPARTURE, not the arrival — otherwise the duration is zero
    // and the leg is thrown away as implausible.
    expect(arrival!.fromAt).toBe(new Date(T0 + MIN).toISOString());
  });

  it("carries a pending departure ACROSS invocations", () => {
    // The OS kills and restarts this task freely, so a drive that starts in one
    // batch and ends in the next is the normal case, not an edge case.
    const first = planBackgroundClockActions([at(SITE_A, T0), away(T0 + MIN)], [SITE_A, SITE_B], "job-a");
    expect(first.pendingDeparture).toEqual({ jobId: "job-a", at: new Date(T0 + MIN).toISOString() });

    const second = planBackgroundClockActions(
      [at(SITE_B, T0 + 30 * MIN)],
      [SITE_A, SITE_B],
      first.insideJobId,
      first.pendingDeparture
    );
    const arrival = second.actions.find((a) => a.type === "arrive");
    expect(arrival!.fromJobId).toBe("job-a");
    expect(arrival!.fromAt).toBe(new Date(T0 + MIN).toISOString());
    // Consumed, so the next arrival cannot invent a second leg from it.
    expect(second.pendingDeparture).toBeNull();
  });

  it("still attributes the teleport case, and times it from the departure", () => {
    const { actions } = planBackgroundClockActions([at(SITE_B, T0)], [SITE_A, SITE_B], "job-a");
    const arrival = actions.find((a) => a.type === "arrive");
    expect(arrival!.fromJobId).toBe("job-a");
    expect(arrival!.fromAt).toBe(new Date(T0).toISOString());
  });

  it("does not attribute a leg to an arrival that follows no departure", () => {
    const { actions } = planBackgroundClockActions([at(SITE_A, T0)], [SITE_A], null);
    const arrival = actions.find((a) => a.type === "arrive");
    expect(arrival!.fromJobId).toBeNull();
    expect(arrival!.fromAt).toBeNull();
  });
});
