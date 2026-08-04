import { shouldRegisterBackgroundSync, backgroundSyncOutcome, MIN_INTERVAL_SECONDS } from "./backgroundSyncPlan";

// THE GAP THIS CLOSES.
//
// The outbox only drains while the app is RUNNING: SyncEngine.start() drains
// once on launch, and again on each connectivity change. Both need a live JS
// runtime. So a technician who works a basement with no signal, queues a
// clock-out and three photos, then pockets the phone and never reopens the app
// has those writes sitting in SQLite — durable, but unsent, for as long as the
// app stays closed. The office sees nothing.
//
// expo-background-fetch is the right tool for exactly that and nothing else. The
// background CLOCK deliberately does NOT use it: geofencing needs
// expo-location's background updates, which deliver on movement rather than on
// a timer.
//
// The OS decides when (and whether) a periodic task runs — the interval is a
// floor, not a promise, and iOS may never grant it. So this is a safety net for
// writes that would otherwise wait indefinitely, never the primary path.

describe("shouldRegisterBackgroundSync", () => {
  it("registers when signed in and not already registered", () => {
    expect(shouldRegisterBackgroundSync({ signedIn: true, alreadyRegistered: false })).toBe(true);
  });

  it("does not re-register when already registered", () => {
    // Re-registering resets the OS's scheduling and can reduce how often the
    // task is granted a slot.
    expect(shouldRegisterBackgroundSync({ signedIn: true, alreadyRegistered: true })).toBe(false);
  });

  it("does NOT register when signed out", () => {
    // A background drain under no session would replay a previous user's queued
    // writes against whoever signs in next.
    expect(shouldRegisterBackgroundSync({ signedIn: false, alreadyRegistered: false })).toBe(false);
  });

  it("keeps a floor of at least 15 minutes", () => {
    // Both platforms ignore anything shorter, and asking for less just burns
    // battery arguing with the scheduler.
    expect(MIN_INTERVAL_SECONDS).toBeGreaterThanOrEqual(15 * 60);
  });
});

describe("backgroundSyncOutcome", () => {
  it("reports NewData when something was actually sent", () => {
    // iOS uses this to decide how generously to schedule the task in future.
    // Always claiming NewData when nothing was sent teaches it to run a no-op.
    expect(backgroundSyncOutcome({ drained: 3, error: null })).toBe("new-data");
  });

  it("reports NoData when the queue was already empty", () => {
    expect(backgroundSyncOutcome({ drained: 0, error: null })).toBe("no-data");
  });

  it("reports Failed when the drain threw", () => {
    // Honesty matters here too: reporting success on a failure is how the OS
    // concludes the task is cheap and reliable when it is neither.
    expect(backgroundSyncOutcome({ drained: 0, error: new Error("offline") })).toBe("failed");
  });

  it("reports Failed even when some rows drained before the error", () => {
    // Partial progress is still a failed run — the remainder is still queued.
    expect(backgroundSyncOutcome({ drained: 2, error: new Error("token expired") })).toBe("failed");
  });
});
