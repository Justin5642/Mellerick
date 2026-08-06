import { applyBackgroundBatch, type BackgroundClockDeps } from "./backgroundClock";
import type { TrackedSite } from "./geofenceState";

jest.mock("expo-location", () => ({}));
jest.mock("expo-task-manager", () => ({}));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  multiRemove: jest.fn(),
}));

// Orchestration of the background auto-clock. Mockist tests: the interesting
// behaviour here is the ORDER and the CONDITIONS of the calls to storage and the
// write path, not arithmetic (that lives in backgroundClockPlan, tested
// classically). Nothing in this layer can be exercised on a device without a
// technician physically driving between two sites.

const SITE_A: TrackedSite = { jobId: "job-a", lat: -37.8136, lng: 144.9631 };
const SITE_B: TrackedSite = { jobId: "job-b", lat: -37.9136, lng: 144.9631 };

const T0 = Date.parse("2026-08-04T08:00:00.000Z");
const at = (s: TrackedSite, ms: number) => ({ coords: { latitude: s.lat, longitude: s.lng }, timestamp: ms });
const away = (ms: number) => ({ coords: { latitude: -37.0, longitude: 144.0 }, timestamp: ms });

function deps(over: Partial<BackgroundClockDeps> = {}): BackgroundClockDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    readInside: jest.fn().mockResolvedValue(null),
    // Persisted across invocations like insideJobId, so a drive that starts in
    // one delivery and ends in the next can still be attributed.
    readPendingDeparture: jest.fn().mockResolvedValue(null),
    writePendingDeparture: jest.fn(async (d: { jobId: string; at: string } | null) => {
      calls.push(`writePendingDeparture(${d ? d.jobId : null})`);
    }),
    writeInside: jest.fn(async (j: string | null) => {
      calls.push(`writeInside(${j})`);
    }),
    readSites: jest.fn().mockResolvedValue([SITE_A, SITE_B]),
    readStaffId: jest.fn().mockResolvedValue("staff-1"),
    onArrive: jest.fn(async (jobId: string) => {
      calls.push(`arrive(${jobId})`);
    }),
    onDepart: jest.fn(async (jobId: string) => {
      calls.push(`depart(${jobId})`);
    }),
    ...over,
  } as BackgroundClockDeps & { calls: string[] };
}

describe("applyBackgroundBatch", () => {
  it("writes an arrival and persists the new state", async () => {
    const d = deps();
    await applyBackgroundBatch([at(SITE_A, T0)], d);
    expect(d.calls).toEqual(["arrive(job-a)", "writeInside(job-a)"]);
  });

  // Ordering is the whole point of doing this sequentially.
  it("closes the old job BEFORE opening the new one when moving between sites", async () => {
    const d = deps({ readInside: jest.fn().mockResolvedValue("job-a") });
    await applyBackgroundBatch([at(SITE_B, T0)], d);
    expect(d.calls).toEqual(["depart(job-a)", "arrive(job-b)", "writeInside(job-b)"]);
  });

  it("passes the previous job AND when it was left, so the travel leg can be attributed", async () => {
    // fromAt is the second half of the fix: knowing only WHERE the drive started
    // left the leg zero-length, so it was computed as implausible and dropped.
    const d = deps({ readInside: jest.fn().mockResolvedValue("job-a") });
    await applyBackgroundBatch([at(SITE_B, T0)], d);
    expect(d.onArrive).toHaveBeenCalledWith(
      "job-b",
      new Date(T0).toISOString(),
      "job-a",
      new Date(T0).toISOString(),
      "staff-1"
    );
  });

  // Writing time entries for a user who has signed out is worse than dropping
  // the readings — it attributes work to the wrong person.
  it("does NOTHING when signed out", async () => {
    const d = deps({ readStaffId: jest.fn().mockResolvedValue(null) });
    await applyBackgroundBatch([at(SITE_A, T0)], d);
    expect(d.calls).toEqual([]);
    expect(d.readSites).not.toHaveBeenCalled();
  });

  it("does nothing when the sites cache is empty — absence is not a departure", async () => {
    const d = deps({ readSites: jest.fn().mockResolvedValue([]), readInside: jest.fn().mockResolvedValue("job-a") });
    await applyBackgroundBatch([away(T0)], d);
    expect(d.calls).toEqual([]);
  });

  it("does not rewrite state when nothing changed", async () => {
    // Saves a storage write on every quiet delivery, which is most of them.
    const d = deps({ readInside: jest.fn().mockResolvedValue("job-a") });
    await applyBackgroundBatch([at(SITE_A, T0)], d);
    expect(d.writeInside).not.toHaveBeenCalled();
  });

  it("applies a whole arrive-and-depart cycle delivered in one batch", async () => {
    // Both writes happen, but NO state write: the technician started outside
    // every site and ended outside every site, so the persisted value is
    // unchanged even though two entries were created in between. Asserting a
    // writeInside(null) here was my mistake, not the code's — the visit is
    // recorded in the time entries, not in the geofence cursor.
    const d = deps();
    await applyBackgroundBatch([at(SITE_A, T0), away(T0 + 90 * 60_000)], d);
    // The pending departure IS written: the technician has left site A and is
    // now driving, and the arrival that closes this leg will very likely be
    // delivered in a later batch — which is exactly the case that could never
    // produce a travel leg before.
    expect(d.calls).toEqual(["arrive(job-a)", "depart(job-a)", "writePendingDeparture(job-a)"]);
    expect(d.writeInside).not.toHaveBeenCalled();
  });

  // If the process dies partway, re-deriving a transition produces a duplicate
  // the write path de-duplicates. Persisting FIRST would skip it and lose the
  // entry outright. For payroll, re-doing beats losing.
  it("persists state only AFTER the writes are enqueued", async () => {
    const order: string[] = [];
    const d = deps({
      onArrive: jest.fn(async () => {
        order.push("arrive");
      }),
      writeInside: jest.fn(async () => {
        order.push("persist");
      }),
    });
    await applyBackgroundBatch([at(SITE_A, T0)], d);
    expect(order).toEqual(["arrive", "persist"]);
  });

  it("stops applying if a write throws, leaving state unpersisted for a retry", async () => {
    const d = deps({
      readInside: jest.fn().mockResolvedValue("job-a"),
      onDepart: jest.fn().mockRejectedValue(new Error("offline")),
    });
    await expect(applyBackgroundBatch([at(SITE_B, T0)], d)).rejects.toThrow("offline");
    expect(d.writeInside).not.toHaveBeenCalled();
  });
});
