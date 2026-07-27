import { SyncEngine } from "./syncEngine";
import type { Processor } from "./outbox/processor";
import type { Connectivity } from "./net/connectivity";

// Let fire-and-forget drains (and their onSettled callbacks) settle.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function fakeProcessor(): jest.Mocked<Pick<Processor, "drain">> {
  return { drain: jest.fn().mockResolvedValue(undefined) };
}

// Connectivity fake that lets a test fire an online transition on demand and
// tracks whether it was unsubscribed.
function fakeConnectivity() {
  let cb: (() => void) | undefined;
  let unsubscribed = false;
  const connectivity: Connectivity = {
    isOnline: async () => true,
    onOnline: (fn) => {
      cb = fn;
      return () => {
        unsubscribed = true;
        cb = undefined; // a real unsubscribe detaches the listener
      };
    },
  };
  return { connectivity, goOnline: () => cb?.(), wasUnsubscribed: () => unsubscribed };
}

describe("SyncEngine", () => {
  it("drains once on start to catch up on anything queued offline", () => {
    const proc = fakeProcessor();
    const { connectivity } = fakeConnectivity();
    new SyncEngine(proc as unknown as Processor, connectivity).start();
    expect(proc.drain).toHaveBeenCalledTimes(1);
  });

  it("drains again on each reconnection", () => {
    const proc = fakeProcessor();
    const net = fakeConnectivity();
    new SyncEngine(proc as unknown as Processor, net.connectivity).start();
    net.goOnline();
    net.goOnline();
    expect(proc.drain).toHaveBeenCalledTimes(3); // 1 start + 2 reconnects
  });

  it("flush() drains on demand (used right after a mutation)", async () => {
    const proc = fakeProcessor();
    const { connectivity } = fakeConnectivity();
    const engine = new SyncEngine(proc as unknown as Processor, connectivity);
    engine.start();
    await engine.flush();
    expect(proc.drain).toHaveBeenCalledTimes(2); // start + flush
  });

  it("notifies onSettled subscribers after each drain (start, reconnect, flush)", async () => {
    const proc = fakeProcessor();
    const net = fakeConnectivity();
    const engine = new SyncEngine(proc as unknown as Processor, net.connectivity);
    const settled = jest.fn();
    const unsub = engine.onSettled(settled);
    engine.start();
    await flushMicrotasks();
    net.goOnline();
    await flushMicrotasks();
    await engine.flush();
    expect(settled).toHaveBeenCalledTimes(3); // start + reconnect + flush
    unsub();
    await engine.flush();
    expect(settled).toHaveBeenCalledTimes(3); // no longer notified after unsub
  });

  it("is idempotent on start and unsubscribes on stop", () => {
    const proc = fakeProcessor();
    const net = fakeConnectivity();
    const engine = new SyncEngine(proc as unknown as Processor, net.connectivity);
    engine.start();
    engine.start(); // second start is a no-op (no duplicate subscription/drain)
    expect(proc.drain).toHaveBeenCalledTimes(1);
    engine.stop();
    expect(net.wasUnsubscribed()).toBe(true);
    net.goOnline(); // no longer subscribed → no drain
    expect(proc.drain).toHaveBeenCalledTimes(1);
  });
});

// Q4: after a long offline workday the access token has expired. The drain that
// fires on reconnection must not race the background token refresh — otherwise
// every queued write 401s and burns its retry budget until it dead-letters.
describe("SyncEngine — session freshness before replay (Q4)", () => {
  it("refreshes the session BEFORE draining, on both start and reconnect", async () => {
    const order: string[] = [];
    const processor = { drain: jest.fn(async () => void order.push("drain")) };
    const net = fakeConnectivity();
    const ensureSession = jest.fn(async () => void order.push("session"));

    const engine = new SyncEngine(processor as unknown as Processor, net.connectivity, ensureSession);
    engine.start();
    await flushMicrotasks();
    net.goOnline();
    await flushMicrotasks();

    // Every drain is preceded by a refresh — never the other way round.
    expect(order).toEqual(["session", "drain", "session", "drain"]);
  });

  it("still drains when the refresh fails (offline refresh must not block replay)", async () => {
    const processor = fakeProcessor();
    const net = fakeConnectivity();
    const ensureSession = jest.fn().mockRejectedValue(new Error("offline"));

    const engine = new SyncEngine(processor as unknown as Processor, net.connectivity, ensureSession);
    engine.start();
    await flushMicrotasks();

    expect(ensureSession).toHaveBeenCalled();
    expect(processor.drain).toHaveBeenCalled(); // not blocked by the failure
  });

  it("works without the hook (optional dependency)", async () => {
    const processor = fakeProcessor();
    const net = fakeConnectivity();
    const engine = new SyncEngine(processor as unknown as Processor, net.connectivity);
    engine.start();
    await flushMicrotasks();
    expect(processor.drain).toHaveBeenCalled();
  });
});
