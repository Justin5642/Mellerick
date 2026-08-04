// Decision logic for the background outbox drain, kept free of native imports
// so it can be tested without a device.
//
// WHY THIS EXISTS. The outbox only drains while the app is RUNNING —
// SyncEngine.start() drains once on launch and again on each connectivity
// change, both of which need a live JS runtime. A technician who works a
// basement with no signal, queues a clock-out and three photos, then pockets the
// phone and does not reopen the app leaves those writes in SQLite: durable, but
// unsent, for as long as the app stays closed. The office sees nothing.
//
// expo-background-fetch exists for precisely that and nothing else. The
// background CLOCK deliberately does not use it — geofencing needs
// expo-location's background updates, which deliver on movement rather than on
// a timer. Using a periodic fetch for geofencing would miss arrivals; using
// location updates to drain a queue would drain it only when someone drives.
//
// This is a SAFETY NET, never the primary path: the OS decides when, and
// whether, a periodic task runs at all.

/** Both platforms ignore anything shorter; iOS treats it as a hint regardless. */
export const MIN_INTERVAL_SECONDS = 15 * 60;

export function shouldRegisterBackgroundSync(state: {
  signedIn: boolean;
  alreadyRegistered: boolean;
}): boolean {
  // Signed out: a background drain would replay the previous user's queued
  // writes against whoever signs in next.
  if (!state.signedIn) return false;
  // Re-registering resets the OS's scheduling history and can reduce how often
  // the task is granted a slot.
  if (state.alreadyRegistered) return false;
  return true;
}

export type BackgroundSyncOutcome = "new-data" | "no-data" | "failed";

/**
 * What to report back to the OS.
 *
 * iOS uses this to decide how generously to schedule the task in future, so the
 * answer has to be true. Always claiming "new data" teaches it to keep running a
 * no-op; claiming success on a failure teaches it the task is cheap and reliable
 * when it is neither.
 */
export function backgroundSyncOutcome(result: { drained: number; error: unknown }): BackgroundSyncOutcome {
  // Partial progress is still a failed run — the remainder is still queued.
  if (result.error) return "failed";
  return result.drained > 0 ? "new-data" : "no-data";
}
