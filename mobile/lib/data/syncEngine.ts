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
    private connectivity: Connectivity
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
    await this.processor.drain();
    for (const cb of [...this.settledListeners]) cb();
  }
}
