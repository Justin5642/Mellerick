import type { Processor } from "./outbox/processor";
import type { Connectivity } from "./net/connectivity";

// The runtime driver for the offline engine — the piece that makes the
// processor actually run in a live app (unit tests drive the processor
// directly). It drains on start (catch-up for anything queued while the app was
// closed), on every reconnection, whenever the app returns to the foreground,
// on demand right after a mutation (flush), and when a backed-off write's retry
// falls due (see scheduleRetry).
// Drains are serialized inside the Processor itself, so overlapping triggers are
// safe. Injected Processor + Connectivity keep this fully unit-testable.
export class SyncEngine {
  private unsubscribe?: () => void;
  private started = false;
  private settledListeners = new Set<() => void>();
  /**
   * Bumped by stop(). A drain captures the generation it began in and abandons
   * itself at every await boundary once that generation is stale.
   *
   * A drain awaits the NETWORK (the session refresh) before it touches SQLite,
   * so there is a window of hundreds of milliseconds in which the engine can be
   * torn down — a sign-out, or a dev reload, which destroys the JS context and
   * every native object with it. Resuming into that dead context and reaching
   * for a SQLite handle throws "Cannot use shared object that was already
   * released". Unsubscribing alone never stopped the work already in the air.
   */
  private generation = 0;
  /** The pending "a backed-off write is now due" drain, if any. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeForeground?: () => void;

  constructor(
    private processor: Processor,
    private connectivity: Connectivity,
    /**
     * Optional: make sure the auth session is fresh before replaying writes (Q4).
     * After a long offline stretch the access token has expired, and the drain
     * triggered by reconnection can otherwise race the background refresh —
     * every queued write 401s, burning its retry budget (~8.5 min of backoff)
     * and dead-lettering work that was perfectly good. Refreshing first removes
     * the race. Injected so the engine keeps no direct auth dependency; failures
     * are swallowed (offline refresh legitimately fails and the drain then
     * no-ops on the connectivity check).
     */
    private ensureSession?: () => Promise<unknown>,
    /**
     * Where a background drain's failure goes. Drains started by start() and by
     * the reconnect handler are fire-and-forget, so anything they throw would
     * otherwise become an UNHANDLED rejection — which React Native puts on the
     * screen as a full-page red error box. A drain failing is ordinary (offline,
     * an expired token, a handle torn down by a reload) and the processor's own
     * retry is what recovers the work, so it must never take over the screen.
     */
    private onError?: (error: unknown) => void,
    /**
     * Subscribe to "the app came back to the foreground" (AppState 'active').
     * Injected so this file stays free of react-native and testable. A phone
     * that was pocketed for an hour has had no reconnect event to drain on —
     * connectivity never dropped — so without this the queue waited for the
     * next mutation or the OS's background-fetch slot.
     */
    private onForeground?: (cb: () => void) => () => void
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    const generation = this.generation;
    this.unsubscribe = this.connectivity.onOnline(() => {
      this.drainInBackground(generation);
    });
    this.unsubscribeForeground = this.onForeground?.(() => {
      this.drainInBackground(generation);
    });
    this.drainInBackground(generation); // catch up on anything queued offline
  }

  /** Ask for a drain without waiting on it — e.g. when the signed-in user changes. */
  requestDrain(): void {
    if (!this.started) return;
    this.drainInBackground(this.generation);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeForeground?.();
    this.unsubscribeForeground = undefined;
    this.clearRetryTimer();
    this.started = false;
    this.generation += 1; // abandons any drain still in flight
    // ...and the PROCESSOR's own loop, which this counter never reached. Both
    // checks here sit outside processor.drain(): they stop a NEW drain starting
    // and skip the post-drain notify, but a pass already inside its while-loop
    // kept dispatching and kept writing through SQLite handles that teardown was
    // about to release. HANDOVER.md:182-186 described this as already fixed.
    this.processor.stop();
  }

  private drainInBackground(generation: number): void {
    void this.drainAndNotify(generation).catch((e) => {
      if (this.onError) this.onError(e);
      else if (__DEV__) console.warn("[sync] background drain failed:", e);
    });
  }

  // Kick a drain after enqueuing a mutation so a queued write goes out
  // immediately when online (and is a harmless no-op when offline).
  async flush(): Promise<void> {
    await this.drainAndNotify(this.generation);
  }

  // Subscribe to "a drain pass just completed", so a screen can reconcile its
  // list against the server AFTER queued writes have actually synced — not on a
  // was-online guess. Returns an unsubscribe fn.
  onSettled(cb: () => void): () => void {
    this.settledListeners.add(cb);
    return () => {
      this.settledListeners.delete(cb);
    };
  }

  private async drainAndNotify(generation: number): Promise<void> {
    if (this.ensureSession) {
      // Never let a refresh failure block the drain — the processor's own
      // connectivity check handles the genuinely-offline case.
      try {
        await this.ensureSession();
      } catch {
        /* keep going; a stale token just means the writes retry */
      }
    }
    // Torn down while we were on the network: the SQLite handles this drain
    // would use may no longer exist. Queued work is durable on disk and the
    // next start() picks it up, so abandoning here loses nothing.
    if (generation !== this.generation) return;
    await this.processor.drain();
    if (generation !== this.generation) return;
    await this.scheduleRetry(generation);
    if (generation !== this.generation) return;
    for (const cb of [...this.settledListeners]) cb();
  }

  /**
   * Arm a drain for when the earliest backed-off operation falls due.
   *
   * THE GAP THIS CLOSES. A write that failed while ONLINE (a 500, a timeout, a
   * flaky moment on a good connection) was backed off by the processor and then
   * nothing ever drained again until a trigger arrived: a reconnect (there is
   * none — the phone never went offline), a new mutation, or the next app start.
   * A clock-out could sit "pending" for the rest of the day with a perfectly
   * good connection.
   *
   * Only armed while the engine is started: the headless background task calls
   * flush() without start(), and a timer there would outlive its purpose.
   */
  private async scheduleRetry(generation: number): Promise<void> {
    if (!this.started) return;
    const wait = await this.processor.msUntilNextRetry();
    if (generation !== this.generation || !this.started) return;
    this.clearRetryTimer();
    if (wait === null) return;
    // Floor of a second so a retry due "now" can never spin the loop.
    const timer = setTimeout(() => {
      this.retryTimer = null;
      this.drainInBackground(generation);
    }, Math.max(wait, 1000));
    // Node (jest) would otherwise hold the process open on a pending retry.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.retryTimer = timer;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
