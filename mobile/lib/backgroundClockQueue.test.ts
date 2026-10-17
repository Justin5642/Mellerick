import {
  MAX_CLOCK_ACTION_FAILURES,
  appendClockActions,
  clearClockActions,
  countClockActions,
  parseClockQueue,
  replayClockActions,
  type ClockQueueStore,
  type QueuedClockAction,
} from "./backgroundClockQueue";
import type { ClockAction } from "./backgroundClockPlan";

// The durable queue behind the background auto-clock. What it must guarantee:
// an action keeps its ORIGINAL timestamp however late it lands, order is kept,
// a dead zone never loses one, and nobody's actions run under someone else's
// session.

function memoryStore(): ClockQueueStore & { queue: QueuedClockAction[] } {
  const s = {
    queue: [] as QueuedClockAction[],
    read: async () => s.queue.map((a) => ({ ...a })),
    write: async (q: QueuedClockAction[]) => {
      s.queue = q.map((a) => ({ ...a }));
    },
  };
  return s;
}

let n = 0;
const newId = () => `id-${++n}`;
const arrive = (jobId: string, at: string): ClockAction => ({ type: "arrive", jobId, at, fromJobId: null, fromAt: null, costCenterId: null });
const depart = (jobId: string, at: string): ClockAction => ({ type: "depart", jobId, at, fromJobId: null, fromAt: null, costCenterId: null });
const network = Object.assign(new Error("Network request failed"), { transient: true });

function applier(impl: (a: QueuedClockAction) => Promise<void>) {
  return {
    apply: jest.fn(impl),
    isTransient: (e: unknown) => (e as { transient?: boolean })?.transient === true,
    onDropped: jest.fn(),
  };
}

describe("background clock queue", () => {
  it("replays an offline arrival later with its ORIGINAL timestamp", async () => {
    const store = memoryStore();
    await appendClockActions(store, [arrive("job-a", "2026-10-17T08:02:00.000Z")], "staff-1", newId);

    const offline = applier(async () => {
      throw network;
    });
    expect(await replayClockActions(store, "staff-1", offline)).toBe(1); // still queued

    const online = applier(async () => {});
    expect(await replayClockActions(store, "staff-1", online)).toBe(0);
    expect(online.apply).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-a", at: "2026-10-17T08:02:00.000Z" }));
  });

  it("never drops an action for network failures, however many", async () => {
    const store = memoryStore();
    await appendClockActions(store, [arrive("job-a", "t1")], "staff-1", newId);
    const offline = applier(async () => {
      throw network;
    });
    for (let i = 0; i < MAX_CLOCK_ACTION_FAILURES * 3; i++) await replayClockActions(store, "staff-1", offline);
    expect(store.queue).toHaveLength(1);
    expect(store.queue[0].failures).toBe(0);
  });

  it("keeps order: a later departure waits behind an arrival that has not landed", async () => {
    const store = memoryStore();
    await appendClockActions(store, [arrive("job-a", "t1"), depart("job-a", "t2")], "staff-1", newId);
    const a = applier(async (action) => {
      if (action.type === "arrive") throw network;
    });
    await replayClockActions(store, "staff-1", a);
    expect(a.apply).toHaveBeenCalledTimes(1);
    expect(store.queue.map((q) => q.type)).toEqual(["arrive", "depart"]);
  });

  it("drops an action the server keeps REJECTING, so it cannot block the rest of the shift — and reports it", async () => {
    const store = memoryStore();
    await appendClockActions(store, [arrive("deleted-job", "t1"), arrive("job-b", "t2")], "staff-1", newId);
    const a = applier(async (action) => {
      if (action.jobId === "deleted-job") throw new Error("violates foreign key constraint");
    });
    for (let i = 0; i < MAX_CLOCK_ACTION_FAILURES - 1; i++) await replayClockActions(store, "staff-1", a);
    expect(store.queue).toHaveLength(2); // still trying, and job-b still waits its turn
    await replayClockActions(store, "staff-1", a);
    expect(store.queue).toEqual([]);
    expect(a.onDropped).toHaveBeenCalledTimes(1);
  });

  it("only replays the signed-in person's actions, leaving others' for their return", async () => {
    const store = memoryStore();
    await appendClockActions(store, [arrive("job-a", "t1")], "alice", newId);
    await appendClockActions(store, [arrive("job-b", "t2")], "bob", newId);
    const a = applier(async () => {});
    await replayClockActions(store, "bob", a);
    expect(a.apply).toHaveBeenCalledTimes(1);
    expect(store.queue.map((q) => q.staffId)).toEqual(["alice"]);
    await replayClockActions(store, null, a); // signed out: nothing
    expect(a.apply).toHaveBeenCalledTimes(1);
  });

  it("gives every action its own row ids, so a replay after a lost response cannot duplicate a row", async () => {
    const store = memoryStore();
    await appendClockActions(store, [arrive("job-a", "t1"), depart("job-a", "t2")], "s", newId);
    const ids = store.queue.flatMap((q) => [q.entryId, q.travelId]);
    expect(new Set(ids).size).toBe(4);
  });

  it("drops a re-derived duplicate of the last queued action (process died before the state advanced)", async () => {
    const store = memoryStore();
    await appendClockActions(store, [arrive("job-a", "08:02")], "s", newId);
    await appendClockActions(store, [arrive("job-a", "08:40")], "s", newId);
    expect(store.queue.map((q) => q.at)).toEqual(["08:02"]); // the original time wins
  });

  it("serializes concurrent replays — a delivery and a foreground drain must not both apply the head", async () => {
    const store = memoryStore();
    await appendClockActions(store, [arrive("job-a", "t1")], "s", newId);
    const a = applier(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    await Promise.all([replayClockActions(store, "s", a), replayClockActions(store, "s", a)]);
    expect(a.apply).toHaveBeenCalledTimes(1);
  });

  it("counts and clears one person's actions for sign-out", async () => {
    const store = memoryStore();
    await appendClockActions(store, [arrive("job-a", "t1"), depart("job-a", "t2")], "alice", newId);
    await appendClockActions(store, [arrive("job-b", "t3")], "bob", newId);
    expect(await countClockActions(store, "alice")).toBe(2);
    await clearClockActions(store, "alice");
    expect(store.queue.map((q) => q.staffId)).toEqual(["bob"]);
  });

  it("reads a corrupt persisted queue as empty rather than throwing on every delivery", () => {
    expect(parseClockQueue("{not json")).toEqual([]);
    expect(parseClockQueue(JSON.stringify([{ type: "arrive" }]))).toEqual([]);
    expect(parseClockQueue(null)).toEqual([]);
  });
});
