// The sync badge's counts: event-driven, with an adaptive poll as the safety
// net. Driven with a REAL Outbox over the in-memory store and a counting spy on
// its COUNT reads, so the assertions are about how often SQLite would be hit.
import { act, renderHook } from "@testing-library/react-native";
import { Outbox } from "./outbox/outbox";
import { InMemoryOutboxStore } from "./outbox/store";
import type { WriteOperation } from "./outbox/types";
import { ACTIVE_POLL_MS, IDLE_POLL_MS } from "./syncStatusCadence";

let mockLayer: unknown = null;
jest.mock("./DataProvider", () => ({ useDataLayer: () => mockLayer }));
jest.mock("../monitoring", () => ({ reportSyncError: jest.fn() }));

import { useSyncStatus } from "./useSyncStatus";

function write(id: string): WriteOperation {
  return {
    kind: "write",
    id,
    rowId: id,
    aggregate: "time_entry",
    op: "insert",
    table: "time_entries",
    payload: {},
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 0,
  };
}

function makeLayer() {
  const outbox = new Outbox(new InMemoryOutboxStore());
  const deadCount = jest.spyOn(outbox, "deadCount");
  const settled = new Set<() => void>();
  const engine = {
    onSettled: (cb: () => void) => {
      settled.add(cb);
      return () => settled.delete(cb);
    },
    flush: jest.fn(async () => {}),
    settle: () => settled.forEach((cb) => cb()),
  };
  return { outbox, engine, reads: () => deadCount.mock.calls.length };
}

/** Let pending promise chains (the COUNT reads) resolve. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  mockLayer = null;
});

describe("useSyncStatus cadence", () => {
  it("does not poll every 3s when the queue is idle — only the 30s heartbeat", async () => {
    const layer = makeLayer();
    mockLayer = layer;
    renderHook(() => useSyncStatus());
    await act(flush);
    expect(layer.reads()).toBe(1); // initial read

    await act(async () => {
      jest.advanceTimersByTime(IDLE_POLL_MS - 1);
      await flush();
    });
    expect(layer.reads()).toBe(1); // the old hook would have read ~10 times here

    await act(async () => {
      jest.advanceTimersByTime(1);
      await flush();
    });
    expect(layer.reads()).toBe(2);
  });

  it("refreshes immediately on enqueue, then polls fast while work is pending", async () => {
    const layer = makeLayer();
    mockLayer = layer;
    const { result } = renderHook(() => useSyncStatus());
    await act(flush);

    await act(async () => {
      await layer.outbox.enqueue(write("w1"));
      await flush();
    });
    expect(result.current.pending).toBe(1); // no 3s wait for the badge to appear
    const afterEvent = layer.reads();

    await act(async () => {
      jest.advanceTimersByTime(ACTIVE_POLL_MS);
      await flush();
    });
    expect(layer.reads()).toBe(afterEvent + 1);
  });

  it("refreshes when a drain settles, and goes idle once the queue is empty", async () => {
    const layer = makeLayer();
    mockLayer = layer;
    const { result } = renderHook(() => useSyncStatus());
    await act(async () => {
      await layer.outbox.enqueue(write("w1"));
      await flush();
    });
    expect(result.current.synced).toBe(false);

    await act(async () => {
      await layer.outbox.markDone("w1");
      layer.engine.settle();
      await flush();
    });
    expect(result.current.synced).toBe(true);
    const settledReads = layer.reads();

    await act(async () => {
      jest.advanceTimersByTime(ACTIVE_POLL_MS * 3);
      await flush();
    });
    expect(layer.reads()).toBe(settledReads); // idle again: no fast polling
  });

  it("stops touching the outbox after unmount (trap 7 liveness guard)", async () => {
    const layer = makeLayer();
    mockLayer = layer;
    const { unmount } = renderHook(() => useSyncStatus());
    await act(flush);
    unmount();
    const before = layer.reads();
    await act(async () => {
      await layer.outbox.enqueue(write("w1"));
      jest.advanceTimersByTime(IDLE_POLL_MS * 2);
      await flush();
    });
    expect(layer.reads()).toBe(before);
  });

  it("swallows a failed read and retries on the fast cadence", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const layer = makeLayer();
    jest.spyOn(layer.outbox, "pendingCount").mockRejectedValueOnce(new Error("released"));
    mockLayer = layer;
    renderHook(() => useSyncStatus());
    await act(flush);
    const { reportSyncError } = jest.requireMock("../monitoring") as { reportSyncError: jest.Mock };
    expect(reportSyncError).toHaveBeenCalledWith(expect.any(Error), "sync-status");
    const before = layer.reads();
    await act(async () => {
      jest.advanceTimersByTime(ACTIVE_POLL_MS);
      await flush();
    });
    expect(layer.reads()).toBe(before + 1);
  });
});
