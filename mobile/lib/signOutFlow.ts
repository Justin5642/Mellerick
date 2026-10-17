import type { DataLayer } from "./data/createDataLayer";

// What happens when someone taps "Sign out".
//
// THE BUG. Signing out left the outbox exactly as it was. The queue was not tied
// to a user, so whoever signed in next replayed the previous person's unsynced
// clock-outs, notes and photos under THEIR session — attributed to the wrong
// person, or (under RLS) rejected eight times and dead-lettered as if it were
// their own failed work. And nothing warned the person signing out that their
// work had not reached the office yet: tapping "Sign out" in a basement silently
// abandoned it on the phone.
//
// Now: ownership (WriteOperation.userId) keeps a queue that survives an
// INVOLUNTARY sign-out (an expired session) safe for its owner's return; and a
// deliberate sign-out says what would be lost, and — only once confirmed —
// actually discards it, files included, so nothing of theirs stays on the
// device for the next person.

export interface SignOutFlowDeps {
  userId: string | null;
  layer: DataLayer | null;
  /** Ask the person; resolve true to go ahead. */
  confirm(message: string): Promise<boolean>;
  /** auth-context's signOut: push token, profile cache, session, image caches. */
  signOut(): Promise<void>;
  /** Queued background auto-clock actions (lib/backgroundClockQueue.ts). */
  countClockActions(userId: string): Promise<number>;
  clearClockActions(userId: string): Promise<void>;
}

export function unsyncedWarning(n: number): string {
  const items = n === 1 ? "1 item hasn't" : `${n} items haven't`;
  return (
    `${items} synced to the office yet. Signing out now will delete ` +
    `${n === 1 ? "it" : "them"} from this phone. Connect to the internet and wait for the sync badge to clear ` +
    "to keep them. Sign out anyway?"
  );
}

/** Returns false when the person chose to stay signed in. */
export async function runSignOut(deps: SignOutFlowDeps): Promise<boolean> {
  const { userId, layer } = deps;
  if (userId) {
    // A count that cannot be read is treated as "maybe something": better an
    // unnecessary question than silently deleting work.
    const [queued, clock] = await Promise.all([
      layer ? layer.outbox.unsyncedCountFor(userId).catch(() => 1) : Promise.resolve(0),
      deps.countClockActions(userId).catch(() => 1),
    ]);
    const unsynced = queued + clock;
    if (unsynced > 0 && !(await deps.confirm(unsyncedWarning(unsynced)))) return false;
  }

  // Stopped first so no drain is mid-dispatch on rows about to be deleted, and
  // none replays this person's work in the moment before the session ends.
  layer?.engine.stop();
  try {
    if (userId) {
      // Confirmed (or nothing was pending): discard. Each step is independent
      // and best-effort — a failure to tidy up must never trap someone in a
      // session they asked to leave.
      await layer?.clearLocalWorkFor(userId).catch((e) => console.warn("[signOut] outbox clear failed:", e));
      await deps.clearClockActions(userId).catch((e) => console.warn("[signOut] clock queue clear failed:", e));
    }
    await deps.signOut();
  } finally {
    // Restarted so the NEXT person's writes drain. With nobody signed in the
    // outbox selects nothing (Outbox.isOwned), so this is idle until sign-in.
    layer?.engine.start();
  }
  return true;
}
