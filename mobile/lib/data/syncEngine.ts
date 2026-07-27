import type { Processor } from "./outbox/processor";
import type { Connectivity } from "./net/connectivity";

// The runtime driver for the offline engine — the piece that makes the
// processor actually run in a live app (unit tests drive the processor
// directly). It drains on start (catch-up for anything queued while the app was
// closed), on every reconnection, and on demand right after a mutation (flush).
// Drains are serialized inside the Processor itself, so overlapping triggers are
// safe. Injected Processor + Connectivity keep this fully unit-testable.
export class SyncEngine {
  private unsubscribe?: () => void;
  private started = false;
  private settledListeners = new Set<() => void>();

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
    private ensureSession?: () => Promise<unknown>
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.connectivity.onOnline(() => {
      void this.drainAndNotify();
    });
    void this.drainAndNotify(); // catch up on anything queued offline
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.started = false;
  }

  // Kick a drain after enqueuing a mutation so a queued write goes out
  // immediately when online (and is a harmless no-op when offline).
  async flush(): Promise<void> {
    await this.drainAndNotify();
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

  private async drainAndNotify(): Promise<void> {
    if (this.ensureSession) {
      // Never let a refresh failure block the drain — the processor's own
      // connectivity check handles the genuinely-offline case.
      try {
        await this.ensureSession();
      } catch {
        /* keep going; a stale token just means the writes retry */
      }
    }
    await this.processor.drain();
    for (const cb of [...this.settledListeners]) cb();
  }
}
