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

// A drain is fire-and-forget and it touches native SQLite AFTER awaiting the
// network. If the engine is torn down during that await — sign-out, or a dev
// reload, which destroys the JS context while the native objects go with it —
// the resumed drain would reach for SQLite handles that no longer exist and die
// with "Cannot use shared object that was already released". stop() must
// therefore abort work already in flight, not merely unsubscribe.
describe("SyncEngine — teardown must abort in-flight work", () => {
  it("does NOT reach the processor when stopped while the session refresh is still pending", async () => {
    const proc = fakeProcessor();
    const net = fakeConnectivity();
    let releaseSession!: () => void;
    const ensureSession = jest.fn(() => new Promise<void>((res) => (releaseSession = res)));

    const engine = new SyncEngine(proc as unknown as Processor, net.connectivity, ensureSession);
    engine.start();
    await flushMicrotasks();
    expect(ensureSession).toHaveBeenCalled();
    expect(proc.drain).not.toHaveBeenCalled(); // still awaiting the refresh

    engine.stop(); // teardown lands mid-flight
    releaseSession();
    await flushMicrotasks();

    expect(proc.drain).not.toHaveBeenCalled(); // the zombie drain was abandoned
  });

  it("does not notify onSettled subscribers for a drain that was aborted by stop()", async () => {
    const proc = fakeProcessor();
    const net = fakeConnectivity();
    let releaseSession!: () => void;
    const ensureSession = jest.fn(() => new Promise<void>((res) => (releaseSession = res)));

    const engine = new SyncEngine(proc as unknown as Processor, net.connectivity, ensureSession);
    const settled = jest.fn();
    engine.onSettled(settled);
    engine.start();
    await flushMicrotasks();

    engine.stop();
    releaseSession();
    await flushMicrotasks();

    expect(settled).not.toHaveBeenCalled();
  });

  it("drains normally again after a stop/start cycle", async () => {
    const proc = fakeProcessor();
    const net = fakeConnectivity();
    const engine = new SyncEngine(proc as unknown as Processor, net.connectivity);

    engine.start();
    await flushMicrotasks();
    engine.stop();
    engine.start();
    await flushMicrotasks();

    expect(proc.drain).toHaveBeenCalledTimes(2); // stop() must not wedge the engine
  });
});

// start() and the reconnect handler launch drains with `void`, so anything the
// drain throws becomes an UNHANDLED promise rejection — which React Native
// surfaces as a full-screen red error box to the user. A failed drain is normal
// (offline, expired token, a torn-down SQLite handle); it must never take the
// screen over. The processor's own retry logic is what recovers the work.
describe("SyncEngine — a failing drain must not surface as an unhandled rejection", () => {
  it("swallows and reports a drain failure on start instead of rejecting", async () => {
    const boom = new Error("Cannot use shared object that was already released");
    const proc = { drain: jest.fn().mockRejectedValue(boom) };
    const net = fakeConnectivity();
    const onError = jest.fn();

    const engine = new SyncEngine(proc as unknown as Processor, net.connectivity, undefined, onError);
    expect(() => engine.start()).not.toThrow();
    await flushMicrotasks();

    expect(proc.drain).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("swallows a drain failure on reconnection too", async () => {
    const proc = { drain: jest.fn().mockRejectedValue(new Error("offline")) };
    const net = fakeConnectivity();
    const onError = jest.fn();

    const engine = new SyncEngine(proc as unknown as Processor, net.connectivity, undefined, onError);
    engine.start();
    await flushMicrotasks();
    onError.mockClear();

    net.goOnline();
    await flushMicrotasks();

    expect(onError).toHaveBeenCalled();
  });

  it("still REJECTS from flush(), whose caller can handle it", async () => {
    // flush() is awaited by callers (the retry button), so it must keep
    // propagating — only the fire-and-forget paths swallow.
    const proc = { drain: jest.fn().mockRejectedValue(new Error("nope")) };
    const net = fakeConnectivity();
    const engine = new SyncEngine(proc as unknown as Processor, net.connectivity);
    engine.start();
    await flushMicrotasks();

    await expect(engine.flush()).rejects.toThrow(/nope/);
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
