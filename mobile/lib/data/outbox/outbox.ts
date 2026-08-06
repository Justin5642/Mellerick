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

// How long a completed operation is kept before pruning. Long enough that
// support can still see what a device sent for a recent job, short enough that
// the queue stays small. See Outbox.pruneCompleted.
export const DEFAULT_PRUNE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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

    // PER-ROW FIFO — the fix for a lost update across a retry.
    //
    // Sorting by createdAt alone let a later op for the SAME ROW overtake an
    // earlier one that had failed and been backed off:
    //
    //   1. op A (job -> in_progress) fails on a blip, backs off
    //   2. op B (job -> completed) is due, dispatches, wins
    //   3. A's backoff elapses, A retries, and the row REVERTS to in_progress
    //
    // The technician marked the job finished and the app quietly un-finished it,
    // with both writes reporting success. Blocking a row behind its own oldest
    // outstanding op removes the overtake.
    //
    // Only "pending", "failed" and "inflight" block. "dead" deliberately does
    // NOT: a dead op will never run again, so blocking on it would freeze that
    // row's queue forever — trading a lost update for a lost everything.
    // KEYED ON THE OP ID, NOT THE TIMESTAMP VALUE.
    //
    // This map used to hold `createdAt`, and the filter below compared
    // `oldestOutstandingByRow.get(rowId) === o.createdAt`. Two outstanding
    // writes for the same row created in the SAME MILLISECOND both satisfy that
    // — a double-tap, or two repository calls in one tick — so both were
    // released and the overtake protection this block exists to provide was
    // void for exactly the case most likely to produce one.
    //
    // The id is unique by construction, so only one op can ever match.
    const oldestOutstandingByRow = new Map<string, { id: string; createdAt: number }>();
    for (const o of all) {
      if (o.kind !== "write") continue;
      if (o.status !== "pending" && o.status !== "failed" && o.status !== "inflight") continue;
      const seen = oldestOutstandingByRow.get(o.rowId);
      // Ties broken by id so the choice is deterministic rather than dependent
      // on the store's iteration order.
      if (seen === undefined || o.createdAt < seen.createdAt || (o.createdAt === seen.createdAt && o.id < seen.id)) {
        oldestOutstandingByRow.set(o.rowId, { id: o.id, createdAt: o.createdAt });
      }
    }

    const ready = all
      .filter((o) => o.status === "pending" || o.status === "failed")
      .filter((o) => isDue(o.nextAttemptAt, now))
      .filter((o) => !o.dependsOn || doneIds.has(o.dependsOn))
      // Side effects are coalesced by key and carry no row, so they are exempt.
      .filter((o) => o.kind !== "write" || oldestOutstandingByRow.get(o.rowId)?.id === o.id)
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

  /**
   * Delete completed operations that nothing still needs, and report how many
   * went.
   *
   * Nothing previously removed them, so the queue grew for the life of the
   * install. That is not just untidy: `nextReady()` calls `store.all()`, which
   * SELECTs the whole table and JSON.parses every row, and it runs in a loop
   * inside `drain()`. Unbounded, a technician's phone does work quadratic in the
   * number of operations it has EVER performed, and holds all of them in memory.
   * A device doing ~50 writes a day passes 18,000 rows inside a year.
   *
   * Two rules make this safe:
   *
   *  - Only `done` operations are eligible. `pending`, `failed` and `inflight`
   *    are live work; `dead` is retained deliberately so `retryDead()` can still
   *    revive it and so the failure stays visible.
   *  - A `done` operation is kept while any non-terminal operation still names it
   *    in `dependsOn`. `nextReady()` unblocks a dependent by finding its
   *    dependency among the done ids, so pruning one early would strand that
   *    dependent as permanently un-runnable — the single way this could lose a
   *    technician's work.
   *
   * The retention window keeps recent history so support can see what a device
   * actually sent. It is measured on the device clock, which can move backwards
   * (see `isDue`) — here that is harmless, since the only effect is pruning later
   * than intended.
   */
  async pruneCompleted(retainMs: number = DEFAULT_PRUNE_RETENTION_MS): Promise<number> {
    const all = await this.store.all();
    // DEAD OPS COUNT AS LIVE HERE. Excluding them looked safe — a dead op is not
    // going to run — but retryDead() resets one to `pending` WITHOUT clearing
    // dependsOn, and nextReady only unblocks a dependent by finding its
    // dependency among the DONE ids. Prune that row and the revived op can never
    // become ready: it sits "pending" forever, and the badge shows nothing worse
    // than a queued write.
    //
    // Concrete path: an admin approves a job offline. createInvoice enqueues the
    // invoice insert (P) and, gated on it, the jobs update (J). P lands. J is
    // rejected MAX_ATTEMPTS times and goes dead. Seven days pass and a drain
    // prunes P. The user taps Retry — and the job is never marked approved.
    const stillNeeded = new Set(
      all
        .filter((o) => o.status !== "done")
        .map((o) => o.dependsOn)
        .filter((id): id is string => Boolean(id))
    );
    const cutoff = this.clock.now() - retainMs;
    let removed = 0;
    for (const o of all) {
      if (o.status !== "done") continue;
      if (stillNeeded.has(o.id)) continue;
      if (o.createdAt > cutoff) continue;
      await this.store.remove(o.id);
      removed++;
    }
    return removed;
  }

  /**
   * Local attachment paths that some operation still expects to upload.
   *
   * Anything staged on disk and absent from this set is unreachable — nothing
   * will ever read it. Includes 'dead' operations, whose files must survive so
   * retryDead() can still upload them.
   */
  async referencedAttachmentUris(): Promise<Set<string>> {
    const all = await this.store.all();
    return new Set(
      all
        .filter((o) => o.kind === "write" && o.status !== "done")
        .map((o) => (o as WriteOperation).attachmentLocalPath)
        .filter((p): p is string => Boolean(p))
    );
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
