import type { Operation, OpStatus } from "./types";
import type { OutboxStore } from "./store";

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

// Exponential backoff for failed operations: 2^attempts seconds, capped at 5min.
export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 5 * 60 * 1000);
}

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
    await this.store.insert(op);
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
  async markFailed(op: Operation, error: string): Promise<void> {
    const attempts = op.attempts + 1;
    await this.store.update(op.id, {
      status: "failed",
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
}

export type { OpStatus };
