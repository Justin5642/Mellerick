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

// The largest wait backoffMs can ever schedule.
const MAX_BACKOFF_MS = backoffMs(Number.MAX_SAFE_INTEGER);

/**
 * True when a backed-off operation is due to run again.
 *
 * `nextAttemptAt` is an ABSOLUTE timestamp taken from the device clock, and that
 * clock is not trustworthy: a technician's phone corrects itself over a long
 * shift — NTP pulling a fast handset back, or a different timezone offset picked
 * up on the road. A backward jump would leave `nextAttemptAt` sitting far in the
 * future, stalling queued work for as long as the jump. Hours of recorded labour
 * would simply not reach payroll, with no error raised and a sync badge showing
 * nothing worse than "pending".
 *
 * No legitimate backoff can schedule further out than MAX_BACKOFF_MS, so a gap
 * larger than that is evidence the clock moved rather than that the wait is
 * real, and the operation is released. Within that window the backoff is
 * honoured normally, so a genuinely failing endpoint is not hammered.
 */
function isDue(nextAttemptAt: number, now: number): boolean {
  if (nextAttemptAt <= now) return true;
  return nextAttemptAt - now > MAX_BACKOFF_MS;
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
    if (op.kind === "write" && (op.op === "delete" || op.op === "update") && !op.dependsOn) {
      // If the target row hasn't synced yet, a queued insert for it still exists.
      // Make the delete/update wait for that insert to COMPLETE — otherwise it can
      // run while the insert is merely backed off after a transient failure:
      //   • a delete's later insert-retry would resurrect the deleted row;
      //   • an update would hit ZERO rows (updateRow on a not-yet-existing id is a
      //     no-op, not an error, so it'd be marked done) and its change — e.g. a
      //     clock-out's hours — would be silently lost when the insert lands with
      //     only the original columns.
      // Only applied when the op has no author-set dependency (compound writes
      // already encode their own ordering); a plain edit-after-offline-create is
      // exactly the unguarded case this closes.
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
        // Count the crash as an attempt. An op that strands "inflight" by hard-
        // crashing the runtime mid-dispatch (e.g. an OOM in uploadObject) would
        // otherwise reclaim→dispatch→crash→reclaim forever without ever accruing
        // attempts — never reaching the terminal "dead" state. Charging an attempt
        // makes a genuine poison-crash op dead-letter after MAX_ATTEMPTS instead.
        const attempts = o.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await this.store.update(o.id, { status: "dead", attempts, error: "crashed repeatedly mid-dispatch" });
        } else {
          await this.store.update(o.id, { status: "pending", attempts, nextAttemptAt: 0 });
        }
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

  // The sync outcome for a specific row's write ops, so a screen can tell whether
  // a mutation was actually ACCEPTED by the server (not merely that we were
  // online). "failed" if any of the row's writes has failed/dead (the drain tried
  // and the server rejected it, or it's backing off) — the screen must not treat
  // it as persisted (e.g. don't navigate to its detail); "pending" if any is
  // still queued/inflight (offline, or a dependency not yet done); "settled" when
  // every write for the row is done (or there are none). "failed" wins over
  // "pending" so a partially-failed compound write is surfaced, not hidden.
  async writeStatus(rowId: string): Promise<"settled" | "pending" | "failed"> {
    const all = await this.store.all();
    const ops = all.filter((o): o is WriteOperation => o.kind === "write" && o.rowId === rowId);
    if (ops.some((o) => o.status === "failed" || o.status === "dead")) return "failed";
    if (ops.some((o) => o.status === "pending" || o.status === "inflight")) return "pending";
    return "settled";
  }

  // The oldest pending op that is ready to run: its backoff has elapsed and its
  // dependency (if any) has completed. Returns undefined if nothing is ready.
  async nextReady(): Promise<Operation | undefined> {
    const now = this.clock.now();
    const all = await this.store.all();
    const doneIds = new Set(all.filter((o) => o.status === "done").map((o) => o.id));
    const ready = all
      .filter((o) => o.status === "pending" || o.status === "failed")
      .filter((o) => isDue(o.nextAttemptAt, now))
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
