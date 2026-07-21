import { Outbox, backoffMs, type Clock } from "./outbox";
import { InMemoryOutboxStore } from "./store";
import type { WriteOperation, SideEffectOperation } from "./types";

function mockClock(start = 1_000_000): Clock & { advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function write(id: string, over: Partial<WriteOperation> = {}): WriteOperation {
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
    ...over,
  };
}

function sideEffect(id: string, coalesceKey: string, over: Partial<SideEffectOperation> = {}): SideEffectOperation {
  return {
    kind: "side_effect",
    id,
    effect: "sync-billing",
    coalesceKey,
    payload: {},
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 0,
    ...over,
  };
}

describe("Outbox", () => {
  it("enqueues writes and returns them oldest-first (FIFO)", async () => {
    const box = new Outbox(new InMemoryOutboxStore(), mockClock());
    await box.enqueue(write("a", { createdAt: 2 }));
    await box.enqueue(write("b", { createdAt: 1 }));
    const next = await box.nextReady();
    expect(next?.id).toBe("b"); // earlier createdAt first
  });

  it("coalesces side-effects with the same key to a single pending op", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, mockClock());
    await box.enqueue(sideEffect("s1", "sync-billing:job1", { payload: { v: 1 } }));
    await box.enqueue(sideEffect("s2", "sync-billing:job1", { payload: { v: 2 } }));
    const all = await store.all();
    const billing = all.filter((o) => o.kind === "side_effect");
    expect(billing).toHaveLength(1); // collapsed to one
    expect((billing[0] as SideEffectOperation).payload).toEqual({ v: 2 }); // latest wins
  });

  it("coalescing adopts the latest trigger's dependency (not the stale first one)", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, mockClock());
    await box.enqueue(sideEffect("s1", "sync-billing:e1", { dependsOn: "insert-op", payload: { entryId: "e1" } }));
    await box.enqueue(sideEffect("s2", "sync-billing:e1", { dependsOn: "update-op", payload: { entryId: "e1" } }));
    const billing = (await store.all()).filter((o) => o.kind === "side_effect");
    expect(billing).toHaveLength(1);
    expect(billing[0].dependsOn).toBe("update-op"); // latest write, not the clock-in insert
  });

  it("does not coalesce side-effects with different keys", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, mockClock());
    await box.enqueue(sideEffect("s1", "sync-billing:job1"));
    await box.enqueue(sideEffect("s2", "sync-billing:job2"));
    expect((await store.all()).length).toBe(2);
  });

  it("holds back an op until its dependency is done", async () => {
    const box = new Outbox(new InMemoryOutboxStore(), mockClock());
    await box.enqueue(write("upload", { createdAt: 1 }));
    await box.enqueue(write("meta", { createdAt: 2, dependsOn: "upload" }));
    // 'upload' is ready first; 'meta' is blocked
    let next = await box.nextReady();
    expect(next?.id).toBe("upload");
    await box.markDone("upload");
    next = await box.nextReady();
    expect(next?.id).toBe("meta"); // now unblocked
  });

  it("applies exponential backoff on failure and hides the op until it elapses", async () => {
    const clock = mockClock();
    const box = new Outbox(new InMemoryOutboxStore(), clock);
    await box.enqueue(write("a"));
    const op = await box.nextReady();
    await box.markFailed(op!, "network error");
    // immediately after failure it is not ready (backoff in the future)
    expect(await box.nextReady()).toBeUndefined();
    clock.advance(backoffMs(1) + 1);
    expect((await box.nextReady())?.id).toBe("a"); // ready again after backoff
  });

  it("counts pending/failed/inflight as outstanding for the sync badge", async () => {
    const box = new Outbox(new InMemoryOutboxStore(), mockClock());
    await box.enqueue(write("a"));
    await box.enqueue(write("b"));
    expect(await box.pendingCount()).toBe(2);
    await box.markDone("a");
    expect(await box.pendingCount()).toBe(1);
  });
});

describe("backoffMs", () => {
  it("grows exponentially and caps at 5 minutes", () => {
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    expect(backoffMs(20)).toBe(5 * 60 * 1000); // capped
  });
});
