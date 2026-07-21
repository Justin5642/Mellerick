import type { Operation, OpStatus, WriteOperation } from "./types";
import type { OutboxStore } from "./store";

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

// Exponential backoff for failed operations: 2^attempts seconds, capped at 5min.
export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 5 * 60 * 1000);
}

// After this many failed attempts a write is considered poison (permanent
// rejection / corrupt payload) and moved to a terminal "dead" state instead of
// retrying forever. ~8 attempts spans ~10 min of backoff before giving up.
export const MAX_ATTEMPTS = 8;

// The write-outbox queue. Owns enqueue (with side-effect coalescing) and the
// FIFO/dependency-aware selection of the next operation to process. It does NOT
// talk to the network — the processor drains it. Pure orchestration over an
// injected store + clock, so it's fully unit-testable.
export class Outbox {
  constructor(
    private store: OutboxStore,
    private clock: Clock = systemClock
  ) {}

  // Add an operation. Side-effects with an existing pending coalesceKey update
  // that op's payload instead of adding a duplicate (only the latest matters).
  async enqueue(op: Operation): Promise<void> {
    if (op.kind === "side_effect") {
      const existing = await this.store.findByCoalesceKey(op.coalesceKey);
      if (existing && existing.kind === "side_effect") {
        // Latest trigger wins — adopt its payload AND its dependency, so a
        // billing-sync re-triggered by a clock-out waits for the clock-out's
        // write, not the stale clock-in write it first coalesced onto.
        await this.store.update(existing.id, {
          payload: op.payload,
          dependsOn: op.dependsOn ?? null,
          status: "pending",
          nextAttemptAt: this.clock.now(),
        });
        return;
      }
    }
    if (op.kind === "write" && op.op === "delete") {
      // If the target row hasn't synced yet, a queued insert for it still
      // exists. Make the delete wait for that insert to COMPLETE — otherwise the
      // delete can run while the insert is merely backed off after a transient
      // failure, and the insert's later retry would resurrect the deleted row.
      const { table, rowId } = op;
      const all = await this.store.all();
      const pendingInsert = all.find((o) => {
        if (o.kind !== "write") return false;
        return o.op === "insert" && o.table === table && o.rowId === rowId && o.status !== "done";
      });
      if (pendingInsert) op = { ...op, dependsOn: pendingInsert.id };
    }
    await this.store.insert(op);
  }

  // Reset ops stranded in "inflight" by a crash/force-quit mid-dispatch back to
  // "pending" so they are retried. Safe because replay is idempotent (upsert on
  // client id, delete tolerates a missing row, upload is upsert). Called at the
  // start of each drain.
  async reclaimInflight(): Promise<void> {
    const all = await this.store.all();
    for (const o of all) {
      if (o.status === "inflight") {
        await this.store.update(o.id, { status: "pending", nextAttemptAt: 0 });
      }
    }
  }

  // If an op depends on one that has terminally failed ("dead"), it can never
  // become ready (nextReady only unblocks on a "done" dependency) — so it would
  // sit "pending" forever, invisible to the badges. Cascade "dead" through the
  // dependency chain so a stranded dependent is surfaced (deadCount) instead.
  async cascadeDeadDependencies(): Promise<void> {
    let changed = true;
    while (changed) {
      changed = false;
      const all = await this.store.all();
      const deadIds = new Set(all.filter((o) => o.status === "dead").map((o) => o.id));
      for (const o of all) {
        if ((o.status === "pending" || o.status === "failed") && o.dependsOn && deadIds.has(o.dependsOn)) {
          await this.store.update(o.id, { status: "dead", error: "dependency failed" });
          changed = true;
        }
      }
    }
  }

  // Manually retry every terminally-failed ("dead") op — resets it (and any dead
  // dependents) to pending with a fresh attempt budget. Triggered by the user
  // tapping the sync badge's Retry. The next drain picks them up.
  async retryDead(): Promise<void> {
    const all = await this.store.all();
    for (const o of all) {
      if (o.status === "dead") {
        await this.store.update(o.id, { status: "pending", attempts: 0, nextAttemptAt: 0, error: null });
      }
    }
  }

  // Row ids of every write still outstanding (not done/dead). A screen merges
  // this with a server read so an optimistic row that hasn't synced yet is not
  // wiped by the reload.
  async pendingRowIds(): Promise<Set<string>> {
    const all = await this.store.all();
    return new Set(
      all
        .filter((o): o is WriteOperation => o.kind === "write" && o.status !== "done" && o.status !== "dead")
        .map((o) => o.rowId)
    );
  }

  // The oldest pending op that is ready to run: its backoff has elapsed and its
  // dependency (if any) has completed. Returns undefined if nothing is ready.
  async nextReady(): Promise<Operation | undefined> {
    const now = this.clock.now();
    const all = await this.store.all();
    const doneIds = new Set(all.filter((o) => o.status === "done").map((o) => o.id));
    const ready = all
      .filter((o) => o.status === "pending" || o.status === "failed")
      .filter((o) => o.nextAttemptAt <= now)
      .filter((o) => !o.dependsOn || doneIds.has(o.dependsOn))
      .sort((a, b) => a.createdAt - b.createdAt);
    return ready[0];
  }

  async markInflight(id: string): Promise<void> {
    await this.store.update(id, { status: "inflight" });
  }

  async markDone(id: string): Promise<void> {
    await this.store.update(id, { status: "done", error: null });
  }

  // Record a failure and schedule the next attempt with exponential backoff.
  // Past MAX_ATTEMPTS the op is parked in the terminal "dead" state rather than
  // retried forever.
  async markFailed(op: Operation, error: string): Promise<void> {
    const attempts = op.attempts + 1;
    const status: OpStatus = attempts >= MAX_ATTEMPTS ? "dead" : "failed";
    await this.store.update(op.id, {
      status,
      attempts,
      nextAttemptAt: this.clock.now() + backoffMs(attempts),
      error,
    });
  }

  async pendingCount(): Promise<number> {
    const [pending, failed, inflight] = await Promise.all([
      this.store.countByStatus("pending"),
      this.store.countByStatus("failed"),
      this.store.countByStatus("inflight"),
    ]);
    return pending + failed + inflight;
  }

  async failedCount(): Promise<number> {
    return this.store.countByStatus("failed");
  }

  // Terminally-failed writes that gave up retrying — surfaced as needs-attention.
  async deadCount(): Promise<number> {
    return this.store.countByStatus("dead");
  }
}

export type { OpStatus };
