import { applyGeofenceTransition, type GeofenceTransitionDeps, type OpenEntryLookup } from "./geofenceTransition";

// The ARRIVAL/DEPARTURE half of the auto-clock, extracted from
// LocationTrackingProvider for the same reason nextGeofenceState was: it lived
// in a closure over three refs and no test could reach it.
//
// WHAT IT HAD TO CATCH. The provider advanced its cursor (insideJobIdRef)
// BEFORE doing async work, then bailed if the network idempotence read failed:
//
//     insideJobIdRef.current = insideJobId;      // cursor consumed
//     ...
//     if (openError) { console.warn(...); return; }   // nothing enqueued
//
// Offline, postgrest-js resolves {data:null, error:{...}} rather than throwing,
// so that branch fired, no outbox operation was created, and because the cursor
// had already moved every later reading returned transition "none". The whole
// visit's clock-in silently never existed. The departure path was worse still:
// it destructured the error away entirely, so the entry never closed and its
// hours later wrote NULL.
//
// The file's own comment argued against exactly this, for a different bail:
// "Bailing after the cursor advanced would consume the arrival and never write
// it — losing the visit rather than delaying it."
//
// Detroit/classicist: the real outbox contract is what matters, so the deps are
// hand-written fakes recording real calls, not mocks asserting "was called".
// The seam is the DATA LAYER, not a database — the failure being reproduced is
// a network read failing while offline, which no real Postgres can express.

function makeDeps(lookup: OpenEntryLookup) {
  const calls: string[] = [];
  const deps: GeofenceTransitionDeps = {
    findOpenEntry: async () => lookup,
    clockIn: async () => {
      calls.push("clockIn");
      return "entry-new";
    },
    clockOut: async () => {
      calls.push("clockOut");
    },
    addTravelLeg: async () => {
      calls.push("addTravelLeg");
    },
    nowIso: () => "2026-08-05T10:00:00.000Z",
    onWarn: () => {},
  };
  return { deps, calls };
}

describe("applyGeofenceTransition — arrival", () => {
  it("clocks in when there is no open entry, and reports the transition handled", async () => {
    const { deps, calls } = makeDeps({ status: "none" });

    const result = await applyGeofenceTransition(
      { kind: "arrival", jobId: "job-a", staffId: "tech-1", pendingDeparture: null },
      deps
    );

    expect(calls).toEqual(["clockIn"]);
    expect(result.handled).toBe(true);
  });

  it("does NOT clock in twice when an entry is already open, and still reports handled", async () => {
    const { deps, calls } = makeDeps({ status: "found", entryId: "e1", clockInIso: "2026-08-05T09:00:00.000Z" });

    const result = await applyGeofenceTransition(
      { kind: "arrival", jobId: "job-a", staffId: "tech-1", pendingDeparture: null },
      deps
    );

    expect(calls).toEqual([]);
    expect(result.handled).toBe(true);
  });

  // THE REGRESSION. This is the defect: offline, the lookup cannot answer.
  it("reports NOT handled when the open-entry lookup fails, so the cursor is not consumed", async () => {
    const { deps, calls } = makeDeps({ status: "unknown", reason: "offline" });

    const result = await applyGeofenceTransition(
      { kind: "arrival", jobId: "job-a", staffId: "tech-1", pendingDeparture: null },
      deps
    );

    // Still must not double-clock-in: "I could not check" is not "there is none".
    expect(calls).toEqual([]);
    // But the arrival MUST be re-derivable. Consuming the cursor here is what
    // lost the visit entirely.
    expect(result.handled).toBe(false);
  });

  it("writes the travel leg for a pending departure, and clears it", async () => {
    const { deps, calls } = makeDeps({ status: "none" });

    const result = await applyGeofenceTransition(
      {
        kind: "arrival",
        jobId: "job-b",
        staffId: "tech-1",
        pendingDeparture: { jobId: "job-a", timeIso: "2026-08-05T09:30:00.000Z" },
      },
      deps
    );

    expect(calls).toEqual(["clockIn", "addTravelLeg"]);
    expect(result.clearPendingDeparture).toBe(true);
    expect(result.handled).toBe(true);
  });

  it("does not write a travel leg whose duration is implausible", async () => {
    const { deps, calls } = makeDeps({ status: "none" });

    const result = await applyGeofenceTransition(
      {
        kind: "arrival",
        jobId: "job-b",
        staffId: "tech-1",
        // 9 hours of "travel" — a backgrounded app, not a drive.
        pendingDeparture: { jobId: "job-a", timeIso: "2026-08-05T01:00:00.000Z" },
      },
      deps
    );

    expect(calls).toEqual(["clockIn"]);
    // Still cleared: keeping it would attach this stale departure to the NEXT
    // arrival and invent an even longer leg.
    expect(result.clearPendingDeparture).toBe(true);
    expect(result.handled).toBe(true);
  });

  it("does not write a travel leg for a backward clock jump", async () => {
    const { deps, calls } = makeDeps({ status: "none" });

    const result = await applyGeofenceTransition(
      {
        kind: "arrival",
        jobId: "job-b",
        staffId: "tech-1",
        // Departure timestamped AFTER arrival — the device clock moved back.
        pendingDeparture: { jobId: "job-a", timeIso: "2026-08-05T11:00:00.000Z" },
      },
      deps
    );

    expect(calls).toEqual(["clockIn"]);
    expect(result.handled).toBe(true);
  });
});

describe("applyGeofenceTransition — departure", () => {
  it("clocks out the open entry and records the pending departure", async () => {
    const { deps, calls } = makeDeps({ status: "found", entryId: "e1", clockInIso: "2026-08-05T09:00:00.000Z" });

    const result = await applyGeofenceTransition(
      { kind: "departure", jobId: "job-a", staffId: "tech-1", pendingDeparture: null },
      deps
    );

    expect(calls).toEqual(["clockOut"]);
    expect(result.handled).toBe(true);
    expect(result.setPendingDeparture).toEqual({ jobId: "job-a", timeIso: "2026-08-05T10:00:00.000Z" });
  });

  it("is handled when there was nothing open to close", async () => {
    const { deps, calls } = makeDeps({ status: "none" });

    const result = await applyGeofenceTransition(
      { kind: "departure", jobId: "job-a", staffId: "tech-1", pendingDeparture: null },
      deps
    );

    expect(calls).toEqual([]);
    expect(result.handled).toBe(true);
    // The departure still starts a travel leg — the technician IS driving.
    expect(result.setPendingDeparture).not.toBeNull();
  });

  // THE SECOND REGRESSION. The original destructured the error away entirely.
  it("reports NOT handled when the lookup fails, so the departure is re-derived", async () => {
    const { deps, calls } = makeDeps({ status: "unknown", reason: "offline" });

    const result = await applyGeofenceTransition(
      { kind: "departure", jobId: "job-a", staffId: "tech-1", pendingDeparture: null },
      deps
    );

    expect(calls).toEqual([]);
    expect(result.handled).toBe(false);
    // And it must NOT start a travel leg from a departure it could not close —
    // that would time the leg from a moment the entry was never ended at.
    expect(result.setPendingDeparture).toBeNull();
  });
});
