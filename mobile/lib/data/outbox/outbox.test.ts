import { Outbox, backoffMs, MAX_ATTEMPTS, type Clock } from "./outbox";
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

  it("does NOT coalesce onto an inflight side-effect (avoids the lost-update on markDone)", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, mockClock());
    await box.enqueue(sideEffect("s1", "transcribe:j1", { payload: { v: 1 } }));
    await box.markInflight("s1"); // s1 is being dispatched
    await box.enqueue(sideEffect("s2", "transcribe:j1", { payload: { v: 2 } }));
    const sides = (await store.all()).filter((o) => o.kind === "side_effect");
    expect(sides).toHaveLength(2); // a fresh op, NOT coalesced onto the inflight one
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

  // A technician's phone corrects its clock. NTP pulls a fast device back, or
  // the handset picks up a different timezone offset on the road. Backoff is
  // stored as an ABSOLUTE timestamp (now + backoff), so a backward jump leaves
  // nextAttemptAt sitting far in the future and the queued work stalls for as
  // long as the jump — hours of recorded labour not reaching payroll, with no
  // error anywhere and a sync badge that just says "pending".
  //
  // No sane clock can put nextAttemptAt further out than the backoff cap, so a
  // gap larger than that is proof the clock moved, not that the wait is real.
  it("still runs a backed-off op after the device clock jumps backwards", async () => {
    const clock = mockClock();
    const box = new Outbox(new InMemoryOutboxStore(), clock);
    await box.enqueue(write("a"));
    const op = await box.nextReady();
    await box.markFailed(op!, "network error");
    expect(await box.nextReady()).toBeUndefined(); // correctly backed off

    clock.advance(-60 * 60 * 1000); // phone corrects itself an hour backwards

    expect((await box.nextReady())?.id).toBe("a");
  });

  it("does not treat an ordinary pending backoff as a clock jump", async () => {
    // The guard must not become "retry everything immediately" — that would
    // hammer a failing endpoint and defeat the backoff entirely.
    const clock = mockClock();
    const box = new Outbox(new InMemoryOutboxStore(), clock);
    await box.enqueue(write("a"));
    const op = await box.nextReady();
    await box.markFailed(op!, "network error");

    clock.advance(backoffMs(1) - 1); // still inside a legitimate backoff window

    expect(await box.nextReady()).toBeUndefined();
  });

  // Nothing ever removed completed operations, so the outbox grew for the life of
  // the install. That is not merely untidy: nextReady() calls store.all(), which
  // SELECTs the whole table and JSON.parses every row, and it is called in a loop
  // inside drain(). Left alone, a technician's phone does O(n²) work in the number
  // of operations it has EVER performed, and holds all of them in memory. Invisible
  // with small test fixtures; it degrades a real device over months of field use.
  describe("pruneCompleted", () => {
    it("removes completed operations so the queue does not grow for the life of the install", async () => {
      const clock = mockClock();
      const store = new InMemoryOutboxStore();
      const box = new Outbox(store, clock);
      await box.enqueue(write("a"));
      const op = await box.nextReady();
      await box.markDone(op!.id);

      clock.advance(8 * 24 * 60 * 60 * 1000); // beyond the retention window
      const removed = await box.pruneCompleted();

      expect(removed).toBe(1);
      expect(await store.all()).toEqual([]);
    });

    it("NEVER prunes a completed op that a live op still depends on", async () => {
      // nextReady unblocks a dependent by looking its dependency up among the
      // DONE ids. Prune that row and the dependent can never become ready again —
      // it would sit pending forever, holding a technician's work hostage. This is
      // the one way pruning could cause data loss, so it is tested explicitly.
      const clock = mockClock();
      const store = new InMemoryOutboxStore();
      const box = new Outbox(store, clock);
      await box.enqueue(write("insert-op"));
      await box.enqueue(write("update-op", { dependsOn: "insert-op" }));
      await box.markDone("insert-op");

      clock.advance(8 * 24 * 60 * 60 * 1000);
      const removed = await box.pruneCompleted();

      expect(removed).toBe(0);
      // and the dependent is still able to run
      expect((await box.nextReady())?.id).toBe("update-op");
    });

    it("keeps recent completed ops so support can see what a device sent", async () => {
      const clock = mockClock();
      const store = new InMemoryOutboxStore();
      const box = new Outbox(store, clock);
      await box.enqueue(write("a"));
      await box.markDone("a");

      clock.advance(60 * 60 * 1000); // an hour — well inside retention
      expect(await box.pruneCompleted()).toBe(0);
      expect((await store.all()).length).toBe(1);
    });

    it("leaves pending, failed, inflight and dead operations alone", async () => {
      const clock = mockClock();
      const store = new InMemoryOutboxStore();
      const box = new Outbox(store, clock);
      await box.enqueue(write("pending-op"));
      await box.enqueue(write("dead-op"));
      await store.update("dead-op", { status: "dead" });

      clock.advance(8 * 24 * 60 * 60 * 1000);
      expect(await box.pruneCompleted()).toBe(0);
      expect((await store.all()).length).toBe(2);
    });
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

describe("Outbox — offline delete/insert ordering + recovery", () => {
  it("makes a delete depend on a not-yet-synced insert for the same row (no resurrection)", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, mockClock());
    await box.enqueue(write("ins", { rowId: "R", op: "insert", table: "job_photos", createdAt: 1 }));
    await box.enqueue(write("del", { rowId: "R", op: "delete", table: "job_photos", createdAt: 2 }));

    const all = await store.all();
    const del = all.find((o) => o.id === "del");
    expect(del?.dependsOn).toBe("ins"); // delete waits for the insert to complete

    // The insert failing/backing off must NOT let the delete run first.
    await box.markFailed((await store.all()).find((o) => o.id === "ins")!, "transient");
    const ready = await box.nextReady();
    expect(ready).toBeUndefined(); // del blocked on ins (not done); ins backed off
    // Once the insert completes, the delete becomes eligible.
    await box.markDone("ins");
    expect((await box.nextReady())?.id).toBe("del");
  });

  it("does NOT add a dependency when deleting an already-synced row (no queued insert)", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, mockClock());
    await box.enqueue(write("del", { rowId: "R", op: "delete", table: "job_photos" }));
    const del = (await store.all()).find((o) => o.id === "del");
    expect(del?.dependsOn ?? null).toBeNull();
    expect((await box.nextReady())?.id).toBe("del"); // runs immediately
  });

  it("makes an UPDATE depend on a not-yet-synced insert for the same row (no silent 0-row update)", async () => {
    // Canonical offline clock-in then clock-out: insert then update of the same
    // row, both queued before any sync. Without the guard, a transient insert
    // failure lets the update run first against a row that doesn't exist yet —
    // updateRow matches 0 rows (a no-op, not an error), the update is marked done,
    // and the clock-out's hours are silently lost when the insert finally lands.
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, mockClock());
    await box.enqueue(write("ins", { rowId: "T", op: "insert", table: "time_entries", createdAt: 1 }));
    await box.enqueue(write("upd", { rowId: "T", op: "update", table: "time_entries", createdAt: 2 }));

    const upd = (await store.all()).find((o) => o.id === "upd");
    expect(upd?.dependsOn).toBe("ins"); // update waits for the insert to complete

    // Insert fails/backs off → the update must NOT become eligible.
    await box.markFailed((await store.all()).find((o) => o.id === "ins")!, "transient");
    expect(await box.nextReady()).toBeUndefined();
    // Once the insert completes, the update runs.
    await box.markDone("ins");
    expect((await box.nextReady())?.id).toBe("upd");
  });

  it("does NOT override an update's author-set dependency (compound writes keep their ordering)", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, mockClock());
    await box.enqueue(write("ins", { rowId: "R", op: "insert", table: "invoices", createdAt: 1 }));
    // An update that already declares a dependency (e.g. a compound-write child)
    // must keep it, not be re-pointed at the same-row insert.
    await box.enqueue(write("upd", { rowId: "R", op: "update", table: "invoices", createdAt: 2, dependsOn: "parentOp" }));
    const upd = (await store.all()).find((o) => o.id === "upd");
    expect(upd?.dependsOn).toBe("parentOp");
  });

  it("does NOT add a dependency when updating an already-synced row (no queued insert)", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, mockClock());
    await box.enqueue(write("upd", { rowId: "R", op: "update", table: "jobs" }));
    const upd = (await store.all()).find((o) => o.id === "upd");
    expect(upd?.dependsOn ?? null).toBeNull();
    expect((await box.nextReady())?.id).toBe("upd"); // runs immediately
  });

  it("reclaims inflight ops (crash recovery) back to pending", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, mockClock());
    await box.enqueue(write("a"));
    await box.markInflight("a");
    expect(await box.nextReady()).toBeUndefined(); // inflight is not selectable
    await box.reclaimInflight();
    expect((await box.nextReady())?.id).toBe("a"); // recovered
  });

  it("parks a write in terminal 'dead' after MAX_ATTEMPTS instead of retrying forever", async () => {
    const clock = mockClock();
    const box = new Outbox(new InMemoryOutboxStore(), clock);
    await box.enqueue(write("a"));
    let op = await box.nextReady();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await box.markFailed(op!, "permanent");
      clock.advance(backoffMs(20) + 1); // jump past any backoff
      op = await box.nextReady();
    }
    expect(op).toBeUndefined(); // dead ops are never re-selected
    expect(await box.deadCount()).toBe(1);
    expect(await box.failedCount()).toBe(0);
  });

  it("cascades 'dead' to dependents so a stranded op surfaces instead of hanging pending forever", async () => {
    const clock = mockClock();
    const box = new Outbox(new InMemoryOutboxStore(), clock);
    // chain: A <- B <- C (C dependsOn B dependsOn A)
    await box.enqueue(write("A", { createdAt: 1 }));
    await box.enqueue(write("B", { createdAt: 2, dependsOn: "A" }));
    await box.enqueue(write("C", { createdAt: 3, dependsOn: "B" }));
    // A dies permanently.
    let a = await box.nextReady();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await box.markFailed(a!, "permanent");
      clock.advance(backoffMs(20) + 1);
      a = await box.nextReady();
    }
    expect(await box.deadCount()).toBe(1); // only A so far
    await box.cascadeDeadDependencies();
    expect(await box.deadCount()).toBe(3); // B and C cascade dead (were pending forever)
    expect(await box.pendingCount()).toBe(0);
  });

  it("retryDead re-queues terminally-failed ops with a fresh attempt budget", async () => {
    const clock = mockClock();
    const box = new Outbox(new InMemoryOutboxStore(), clock);
    await box.enqueue(write("a"));
    let op = await box.nextReady();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await box.markFailed(op!, "permanent");
      clock.advance(backoffMs(20) + 1);
      op = await box.nextReady();
    }
    expect(await box.deadCount()).toBe(1);
    await box.retryDead();
    expect(await box.deadCount()).toBe(0);
    expect((await box.nextReady())?.id).toBe("a"); // eligible again
  });

  it("pendingRowIds reports outstanding write rows and excludes done/dead", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, mockClock());
    await box.enqueue(write("op1", { rowId: "R1" }));
    await box.enqueue(write("op2", { rowId: "R2" }));
    await box.markDone("op1");
    const ids = await box.pendingRowIds();
    expect(ids.has("R2")).toBe(true);
    expect(ids.has("R1")).toBe(false); // done → not pending
  });

  it("writeStatus reports a row's sync outcome (settled / pending / failed)", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, mockClock());
    // Unknown row → settled (nothing outstanding to worry about).
    expect(await box.writeStatus("R0")).toBe("settled");
    // Queued, not yet run → pending.
    await box.enqueue(write("op1", { rowId: "R1" }));
    expect(await box.writeStatus("R1")).toBe("pending");
    // Completed → settled.
    await box.markDone("op1");
    expect(await box.writeStatus("R1")).toBe("settled");
    // A failed op for the row → failed (drain tried and the server rejected it).
    await box.enqueue(write("op2", { rowId: "R2" }));
    await box.markFailed((await store.all()).find((o) => o.id === "op2")!, "rejected");
    expect(await box.writeStatus("R2")).toBe("failed");
  });

  it("writeStatus prefers 'failed' over 'pending' when a row has both", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, mockClock());
    await box.enqueue(write("ins", { rowId: "R", op: "insert", createdAt: 1 }));
    await box.enqueue(write("upd", { rowId: "R", op: "update", createdAt: 2 }));
    await box.markFailed((await store.all()).find((o) => o.id === "ins")!, "rejected");
    // insert failed, update still pending → the row's outcome is 'failed'.
    expect(await box.writeStatus("R")).toBe("failed");
  });
});

describe("backoffMs", () => {
  it("grows exponentially and caps at 5 minutes", () => {
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    expect(backoffMs(20)).toBe(5 * 60 * 1000); // capped
  });
});
