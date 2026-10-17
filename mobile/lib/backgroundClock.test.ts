import { applyBackgroundBatch, type BackgroundClockDeps } from "./backgroundClock";
import type { ClockAction } from "./backgroundClockPlan";
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

const SITE_A: TrackedSite = { jobId: "job-a", lat: -37.8136, lng: 144.9631, scheduledCostCenterId: null };
const SITE_B: TrackedSite = { jobId: "job-b", lat: -37.9136, lng: 144.9631, scheduledCostCenterId: null };

const T0 = Date.parse("2026-08-04T08:00:00.000Z");
const at = (s: TrackedSite, ms: number) => ({ coords: { latitude: s.lat, longitude: s.lng }, timestamp: ms });
const away = (ms: number) => ({ coords: { latitude: -37.0, longitude: 144.0 }, timestamp: ms });

// The queue here is a list in memory; replayPending applies it through
// onArrive/onDepart in order, as the real one (lib/backgroundClockQueue.ts,
// tested on its own) does — so the ORDER of writes stays observable.
function deps(over: Partial<BackgroundClockDeps> = {}): BackgroundClockDeps & { calls: string[]; queued: ClockAction[] } {
  const calls: string[] = [];
  const queued: ClockAction[] = [];
  const d = {
    calls,
    queued,
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
    enqueueActions: jest.fn(async (actions: ClockAction[]) => {
      if (actions.length) calls.push(`enqueue(${actions.map((a) => `${a.type}:${a.jobId}`).join(",")})`);
      queued.push(...actions);
    }),
    replayPending: jest.fn(async () => {
      while (queued.length) {
        const a = queued[0];
        if (a.type === "depart") await d.onDepart(a.jobId, a.at, "staff-1");
        else await d.onArrive(a.jobId, a.at, a.fromJobId, a.fromAt, "staff-1", a.costCenterId);
        queued.shift();
      }
    }),
    ...over,
  } as BackgroundClockDeps & { calls: string[]; queued: ClockAction[] };
  return d;
}

describe("applyBackgroundBatch", () => {
  it("writes an arrival and persists the new state", async () => {
    const d = deps();
    await applyBackgroundBatch([at(SITE_A, T0)], d);
    expect(d.calls).toEqual(["enqueue(arrive:job-a)", "writeInside(job-a)", "arrive(job-a)"]);
  });

  // Ordering is the whole point of doing this sequentially.
  it("closes the old job BEFORE opening the new one when moving between sites", async () => {
    const d = deps({ readInside: jest.fn().mockResolvedValue("job-a") });
    await applyBackgroundBatch([at(SITE_B, T0)], d);
    expect(d.calls).toEqual(["enqueue(depart:job-a,arrive:job-b)", "writeInside(job-b)", "depart(job-a)", "arrive(job-b)"]);
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
      "staff-1",
      null
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
    expect(d.calls).toEqual(["enqueue(arrive:job-a,depart:job-a)", "writePendingDeparture(job-a)", "arrive(job-a)", "depart(job-a)"]);
    expect(d.writeInside).not.toHaveBeenCalled();
  });

  // THE FIX. Writes used to go first and the state only advanced if they all
  // succeeded, "so the next delivery re-derives the transition". It did not —
  // the next delivery planned from ITS readings, so an offline arrival came
  // back stamped late, or vanished if the technician had already left. Now the
  // planned action is queued (durably, with its own timestamp) BEFORE the state
  // advances, and the state advances whether or not the write gets through.
  it("queues the planned actions BEFORE advancing the state, and writes after", async () => {
    const order: string[] = [];
    const d = deps({
      enqueueActions: jest.fn(async () => {
        order.push("enqueue");
      }),
      writeInside: jest.fn(async () => {
        order.push("persist");
      }),
      replayPending: jest.fn(async () => {
        order.push("replay");
      }),
    });
    await applyBackgroundBatch([at(SITE_A, T0)], d);
    expect(order).toEqual(["enqueue", "persist", "replay"]);
  });

  it("queues the arrival with the READING's timestamp, not the time it is written", async () => {
    const d = deps({ replayPending: jest.fn(async () => {}) }); // offline: nothing replays
    await applyBackgroundBatch([at(SITE_A, T0)], d);
    expect(d.queued).toEqual([expect.objectContaining({ type: "arrive", jobId: "job-a", at: new Date(T0).toISOString() })]);
  });

  it("advances the state even when the write cannot get through, so the arrival is not re-derived later", async () => {
    // A replay that fails leaves the action queued (lib/backgroundClockQueue)
    // and resolves; the geofence cursor must already say "inside job-a".
    const d = deps({ replayPending: jest.fn(async () => {}) });
    await applyBackgroundBatch([at(SITE_A, T0)], d);
    expect(d.writeInside).toHaveBeenCalledWith("job-a");
    // The next delivery, still on site, plans nothing new — no second arrival
    // stamped with a later time.
    const next = deps({ readInside: jest.fn().mockResolvedValue("job-a"), replayPending: jest.fn(async () => {}) });
    await applyBackgroundBatch([at(SITE_A, T0 + 40 * 60_000)], next);
    expect(next.queued).toEqual([]);
  });

  it("replays earlier leftovers even when this delivery planned nothing", async () => {
    const d = deps({ readInside: jest.fn().mockResolvedValue("job-a") });
    await applyBackgroundBatch([at(SITE_A, T0)], d);
    expect(d.replayPending).toHaveBeenCalledTimes(1);
  });

  it("does not advance the state if the actions could not be queued (a storage fault)", async () => {
    const d = deps({ enqueueActions: jest.fn().mockRejectedValue(new Error("disk full")) });
    await expect(applyBackgroundBatch([at(SITE_A, T0)], d)).rejects.toThrow("disk full");
    expect(d.writeInside).not.toHaveBeenCalled();
  });
});
