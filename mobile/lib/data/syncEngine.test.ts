import { SyncEngine } from "./syncEngine";
import type { Processor } from "./outbox/processor";
import type { Connectivity } from "./net/connectivity";

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
