import { Outbox, backoffMs, MAX_ATTEMPTS, DEFAULT_PRUNE_RETENTION_MS, type Clock } from "./outbox";
import { InMemoryOutboxStore } from "./store";
import type { WriteOperation, SideEffectOperation } from "./types";

// Behaviour added for the 2026-10 sync-reliability audit, kept apart from
// outbox.test.ts so each finding's tests read as one story:
//   • ownership — queued work belongs to the user who queued it
//   • transient failures never dead-letter
//   • Retry cannot revive a write a newer one has already overtaken
//   • msUntilNextRetry — what the engine schedules its retry drain from

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
  return { kind: "side_effect", id, effect: "sync-billing", coalesceKey, payload: {}, status: "pending", attempts: 0, nextAttemptAt: 0, createdAt: 0, ...over };
}

function ownedBox(owner: { current: string | null }, clock = mockClock(), store = new InMemoryOutboxStore()) {
  return { box: new Outbox(store, clock, undefined, () => owner.current), store, clock };
}

describe("ownership — queued work belongs to whoever queued it", () => {
  it("stamps each new operation with the signed-in user", async () => {
    const owner = { current: "alice" };
    const { box, store } = ownedBox(owner);
    await box.enqueue(write("a"));
    expect((await store.all())[0].userId).toBe("alice");
  });

  it("never selects another user's operation — bob must not replay alice's clock-out", async () => {
    const owner = { current: "alice" };
    const { box } = ownedBox(owner);
    await box.enqueue(write("a"));
    owner.current = "bob";
    expect(await box.nextReady()).toBeUndefined();
    owner.current = "alice";
    expect((await box.nextReady())?.id).toBe("a"); // waits for its owner, untouched
  });

  it("selects nothing at all while nobody is signed in", async () => {
    const owner = { current: "alice" as string | null };
    const { box } = ownedBox(owner);
    await box.enqueue(write("a"));
    owner.current = null;
    expect(await box.nextReady()).toBeUndefined();
  });

  it("another user's stuck write does not block this user's write to the same row", async () => {
    const owner = { current: "alice" };
    const { box, store } = ownedBox(owner);
    // Inserted directly (already stamped) so enqueue's insert-dependency guard
    // does not chain them — this is about the per-row FIFO alone.
    await store.insert(write("old", { rowId: "r", op: "update", createdAt: 1, userId: "alice" }));
    await store.insert(write("new", { rowId: "r", op: "update", createdAt: 2, userId: "bob" }));
    owner.current = "bob";
    expect((await box.nextReady())?.id).toBe("new");
  });

  it("an operation queued before ownership existed is adopted by the first user to drain, not dropped", async () => {
    const owner = { current: "alice" };
    const store = new InMemoryOutboxStore();
    // Written by the previous build: no userId field at all.
    await store.insert(write("legacy"));
    const box = new Outbox(store, mockClock(), undefined, () => owner.current);
    expect((await box.nextReady())?.id).toBe("legacy"); // eligible before adoption
    await box.adoptUnowned();
    expect((await store.all())[0].userId).toBe("alice");
    owner.current = "bob";
    expect(await box.nextReady()).toBeUndefined(); // and now it is alice's
  });

  it("does not coalesce a side effect onto another user's queued one", async () => {
    const owner = { current: "alice" };
    const { box, store } = ownedBox(owner);
    await box.enqueue(sideEffect("s1", "sync-billing:e1", { payload: { v: 1 } }));
    owner.current = "bob";
    await box.enqueue(sideEffect("s2", "sync-billing:e1", { payload: { v: 2 } }));
    const all = await store.all();
    expect(all.map((o) => [o.id, o.userId, o.payload])).toEqual([
      ["s1", "alice", { v: 1 }],
      ["s2", "bob", { v: 2 }],
    ]);
  });

  it("counts a user's unsynced work (dead included) for the sign-out warning, and nobody else's", async () => {
    const owner = { current: "alice" };
    const { box, store } = ownedBox(owner);
    await box.enqueue(write("a"));
    await box.enqueue(write("b"));
    await box.enqueue(write("c"));
    await store.update("b", { status: "dead" });
    await store.update("c", { status: "done" });
    owner.current = "bob";
    await box.enqueue(write("d"));
    expect(await box.unsyncedCountFor("alice")).toBe(2);
    expect(await box.unsyncedCountFor("bob")).toBe(1);
  });

  it("clearForOwner removes that user's (and unowned) operations only", async () => {
    const owner = { current: "alice" };
    const { box, store } = ownedBox(owner);
    await box.enqueue(write("a"));
    await store.insert(write("legacy"));
    owner.current = "bob";
    await box.enqueue(write("b"));
    expect(await box.clearForOwner("alice")).toBe(2);
    expect((await store.all()).map((o) => o.id)).toEqual(["b"]);
  });

  it("without an owner function (tests, previews) everything stays eligible, as before", async () => {
    const box = new Outbox(new InMemoryOutboxStore(), mockClock());
    await box.enqueue(write("a", { userId: "someone" }));
    expect((await box.nextReady())?.id).toBe("a");
  });
});

describe("transient failures — a dead zone must not dead-letter good work", () => {
  it("never reaches 'dead' however many network failures pile up", async () => {
    const clock = mockClock();
    const box = new Outbox(new InMemoryOutboxStore(), clock);
    await box.enqueue(write("a"));
    for (let i = 0; i < MAX_ATTEMPTS * 3; i++) {
      const op = await box.nextReady();
      expect(op?.id).toBe("a");
      await box.markFailed(op!, "TypeError: Network request failed", { transient: true });
      clock.advance(backoffMs(100) + 1);
    }
    expect(await box.deadCount()).toBe(0);
    expect(await box.failedCount()).toBe(1);
    const op = await box.nextReady();
    expect(op?.attempts).toBe(0); // the rejection budget is untouched
  });

  it("still backs off exponentially, so a down server is not hammered", async () => {
    const clock = mockClock();
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, clock);
    await box.enqueue(write("a"));
    await box.markFailed((await box.nextReady())!, "timeout", { transient: true });
    await box.markFailed((await store.all())[0], "timeout", { transient: true });
    await box.markFailed((await store.all())[0], "timeout", { transient: true });
    const op = (await store.all())[0];
    expect(op.transientFailures).toBe(3);
    expect(op.nextAttemptAt - clock.now()).toBe(backoffMs(3));
  });

  it("a REJECTION still counts and still dead-letters (negative control)", async () => {
    const clock = mockClock();
    const box = new Outbox(new InMemoryOutboxStore(), clock);
    await box.enqueue(write("a"));
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const op = await box.nextReady();
      await box.markFailed(op!, "new row violates row-level security policy");
      clock.advance(backoffMs(20) + 1);
    }
    expect(await box.deadCount()).toBe(1);
  });
});

describe("retryDead — Retry must not revert a newer edit", () => {
  it("does not revive a dead write when a NEWER write to the same row has already synced", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, mockClock());
    // A: job -> in_progress (dead). B: job -> completed (landed, while A sat dead).
    await store.insert(write("A", { rowId: "job-1", table: "jobs", op: "update", createdAt: 1, status: "dead", payload: { status: "in_progress" } }));
    await store.insert(write("B", { rowId: "job-1", table: "jobs", op: "update", createdAt: 2, status: "done", payload: { status: "completed" } }));
    await box.retryDead();
    expect(await box.nextReady()).toBeUndefined(); // A will not run
    const a = (await store.all()).find((o) => o.id === "A")!;
    expect(a.status).toBe("done");
    expect(a.error).toMatch(/superseded/);
  });

  it("revives a dead write when nothing newer has landed (negative control)", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, mockClock());
    await store.insert(write("A", { rowId: "job-1", table: "jobs", op: "update", createdAt: 2, status: "dead", attempts: 8 }));
    // An OLDER done write is no reason to drop A.
    await store.insert(write("Z", { rowId: "job-1", table: "jobs", op: "update", createdAt: 1, status: "done" }));
    await box.retryDead();
    const a = await box.nextReady();
    expect(a?.id).toBe("A");
    expect(a?.attempts).toBe(0);
  });

  it("keeps a NEWER pending write behind the revived one, so order is preserved", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, mockClock());
    await store.insert(write("A", { rowId: "job-1", table: "jobs", op: "update", createdAt: 1, status: "dead" }));
    await store.insert(write("B", { rowId: "job-1", table: "jobs", op: "update", createdAt: 2, status: "pending" }));
    await box.retryDead();
    expect((await box.nextReady())?.id).toBe("A");
  });

  it("does not prune the newer done write while a dead write to its row still exists — it is the evidence", async () => {
    const clock = mockClock(DEFAULT_PRUNE_RETENTION_MS * 10);
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, clock);
    await store.insert(write("A", { rowId: "job-1", table: "jobs", op: "update", createdAt: 1, status: "dead" }));
    await store.insert(write("B", { rowId: "job-1", table: "jobs", op: "update", createdAt: 2, status: "done" }));
    await store.insert(write("C", { rowId: "other", createdAt: 2, status: "done" }));
    expect(await box.pruneCompleted()).toBe(1); // only C
    await box.retryDead();
    expect(await box.nextReady()).toBeUndefined();
  });
});

describe("msUntilNextRetry — when the engine should drain again", () => {
  it("reports the earliest pending backoff", async () => {
    const clock = mockClock();
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, clock);
    await box.enqueue(write("a"));
    await box.enqueue(write("b"));
    await store.update("a", { status: "failed", nextAttemptAt: clock.now() + 8_000 });
    await store.update("b", { status: "failed", nextAttemptAt: clock.now() + 2_000 });
    expect(await box.msUntilNextRetry()).toBe(2_000);
  });

  it("is null when nothing is backing off — an op that is due but blocked must not spin a timer", async () => {
    const box = new Outbox(new InMemoryOutboxStore(), mockClock());
    await box.enqueue(write("dep", { createdAt: 1, status: "failed", nextAttemptAt: 0 }));
    await box.enqueue(write("blocked", { createdAt: 2, dependsOn: "dep" }));
    expect(await box.msUntilNextRetry()).toBeNull();
  });

  it("is clamped to the longest real backoff when the clock has jumped backwards", async () => {
    const clock = mockClock();
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, clock);
    await box.enqueue(write("a"));
    await store.update("a", { status: "failed", nextAttemptAt: clock.now() + 24 * 60 * 60 * 1000 });
    expect(await box.msUntilNextRetry()).toBe(backoffMs(Number.MAX_SAFE_INTEGER));
  });

  it("ignores other users' backoffs", async () => {
    const owner = { current: "alice" };
    const { box, store, clock } = ownedBox(owner);
    await box.enqueue(write("a"));
    await store.update("a", { status: "failed", nextAttemptAt: clock.now() + 2_000 });
    owner.current = "bob";
    expect(await box.msUntilNextRetry()).toBeNull();
  });
});
