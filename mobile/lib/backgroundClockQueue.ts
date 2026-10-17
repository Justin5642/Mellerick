import type { ClockAction } from "./backgroundClockPlan";

// A durable queue for the background auto-clock's planned writes.
//
// THE LOSS THIS CLOSES. The background task wrote each arrival/departure to
// Supabase directly, and on failure persisted nothing, relying on "the next
// delivery re-derives the same transition". It does not. The next delivery
// re-plans from ITS readings, so an arrival at 8:02 that failed in a dead zone
// was re-derived — at best — at whatever time the next reading came in (8:40,
// once the phone found signal), and at worst never: if the technician had
// already left by the next delivery, the planner saw "outside, was outside" and
// the visit vanished. Lost or shortened hours on a payslip, and no error
// anywhere: the failure was swallowed (correctly — an exception escaping a
// TaskManager task can stop deliveries for good) and nothing else remembered it.
//
// Now the planned actions are appended here, with their ORIGINAL timestamps,
// BEFORE the geofence state advances; the state then advances unconditionally
// (the transition is recorded, so it must not be re-derived later at a later
// time); and the queue is replayed in order — on every delivery, after every
// outbox drain while the app is open, and from the background-sync task.
//
// Not the outbox, deliberately: the outbox is opened by DataProvider and the
// background-sync task, and its rows are planned client-side as complete
// writes. These actions need a server read at replay time (is an entry already
// open for this job? what was its clock_in?) to stay idempotent alongside the
// foreground path, which writes the same rows. A small, separate queue keeps
// those semantics intact.

export interface QueuedClockAction extends ClockAction {
  /** Whose shift this is. Replayed only under that user's session. */
  staffId: string;
  /** Client id for the work entry an arrival creates — makes the insert idempotent. */
  entryId: string;
  /** Client id for the travel leg an arrival may create. */
  travelId: string;
  /** Rejections (not network failures) so far. See MAX_CLOCK_ACTION_FAILURES. */
  failures: number;
}

export interface ClockQueueStore {
  read(): Promise<QueuedClockAction[]>;
  write(actions: QueuedClockAction[]): Promise<void>;
}

export interface ClockActionApplier {
  apply(action: QueuedClockAction): Promise<void>;
  /** True when the failure says nothing about the action (no signal, timeout, 5xx). */
  isTransient(error: unknown): boolean;
  /** Told when an action is given up on. Must not throw. */
  onDropped?(action: QueuedClockAction, error: unknown): void;
}

/**
 * Rejections tolerated before an action is dropped. A rejected time entry (RLS,
 * a deleted job) will never be accepted, and holding it at the head would block
 * every later arrival and departure behind it forever. Network failures never
 * count — a day in a dead zone must not lose a day's clock events.
 */
export const MAX_CLOCK_ACTION_FAILURES = 5;

export const CLOCK_QUEUE_KEY = "mellerick.backgroundClock.pendingActions";

// Every read-modify-write of the queue is serialized. A delivery and a
// foreground drain can replay in the same JS context at the same moment, and
// two interleaved replays would each apply the head action.
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(work: () => Promise<T>): Promise<T> {
  const next = lock.then(work, work);
  lock = next.catch(() => {});
  return next;
}

/**
 * Append freshly planned actions. An action identical in type and job to the
 * last still-queued one for the same person is skipped: that is a transition
 * re-derived after the process died between queueing it and advancing the
 * geofence state, and replaying both would double-count a travel leg.
 */
export function appendClockActions(
  store: ClockQueueStore,
  actions: ClockAction[],
  staffId: string,
  newId: () => string
): Promise<void> {
  if (actions.length === 0) return Promise.resolve();
  return withLock(async () => {
    const queue = await store.read();
    for (const action of actions) {
      const last = [...queue].reverse().find((q) => q.staffId === staffId);
      if (last && last.type === action.type && last.jobId === action.jobId) continue;
      queue.push({ ...action, staffId, entryId: newId(), travelId: newId(), failures: 0 });
    }
    await store.write(queue);
  });
}

/**
 * Apply queued actions belonging to `staffId`, oldest first.
 *
 * Stops at the first failure so order is kept — a departure must never land
 * before the arrival it closes. Other people's actions are left untouched for
 * their owner's next session. Never throws for an action's failure; only a
 * storage fault escapes. Returns how many actions remain for `staffId`.
 */
export function replayClockActions(
  store: ClockQueueStore,
  staffId: string | null,
  applier: ClockActionApplier
): Promise<number> {
  return withLock(async () => {
    let queue = await store.read();
    if (!staffId) return 0;
    for (const action of [...queue]) {
      if (action.staffId !== staffId) continue;
      try {
        await applier.apply(action);
        queue = queue.filter((q) => q !== action);
        // Persisted after EACH action: a process killed mid-replay must not
        // re-apply what already landed (harmless — every apply is idempotent —
        // but wasteful on a metered connection).
        await store.write(queue);
      } catch (e) {
        if (applier.isTransient(e)) break;
        const failures = action.failures + 1;
        if (failures >= MAX_CLOCK_ACTION_FAILURES) {
          queue = queue.filter((q) => q !== action);
          await store.write(queue);
          try {
            applier.onDropped?.(action, e);
          } catch {
            // reporting must not stop the replay
          }
          continue; // the next action is no longer blocked
        }
        queue = queue.map((q) => (q === action ? { ...q, failures } : q));
        await store.write(queue);
        break;
      }
    }
    return queue.filter((q) => q.staffId === staffId).length;
  });
}

/** How many actions `staffId` would lose by signing out now. */
export async function countClockActions(store: ClockQueueStore, staffId: string): Promise<number> {
  return (await store.read()).filter((q) => q.staffId === staffId).length;
}

/** Forget `staffId`'s queued actions — only on a sign-out they have confirmed. */
export function clearClockActions(store: ClockQueueStore, staffId: string): Promise<void> {
  return withLock(async () => {
    const queue = await store.read();
    await store.write(queue.filter((q) => q.staffId !== staffId));
  });
}

/** Parse the persisted queue; a corrupt value reads as empty rather than throwing forever. */
export function parseClockQueue(raw: string | null): QueuedClockAction[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a) =>
        a &&
        (a.type === "arrive" || a.type === "depart") &&
        typeof a.jobId === "string" &&
        typeof a.at === "string" &&
        typeof a.staffId === "string" &&
        typeof a.entryId === "string" &&
        typeof a.travelId === "string"
    ).map((a) => ({ ...a, failures: typeof a.failures === "number" ? a.failures : 0 }));
  } catch {
    return [];
  }
}
