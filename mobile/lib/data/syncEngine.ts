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

  constructor(
    private processor: Processor,
    private connectivity: Connectivity
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.connectivity.onOnline(() => {
      void this.processor.drain();
    });
    void this.processor.drain(); // catch up on anything queued offline
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.started = false;
  }

  // Kick a drain after enqueuing a mutation so a queued write goes out
  // immediately when online (and is a harmless no-op when offline).
  async flush(): Promise<void> {
    await this.processor.drain();
  }
}
